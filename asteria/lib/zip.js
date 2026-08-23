'use strict';
// Минимальный ZIP-writer без внешних зависимостей (проект сознательно не
// тянет npm-пакеты — см. package.json). Нужен для /api/admin/export/archive:
// одним архивом отдаём и файл базы данных, и все загруженные файлы
// (аватарки, сторис, обои), чтобы перенос на другой сервер был "положил
// архив — распаковал — готово", без сборки руками из нескольких выгрузок.
//
// Пишет записи в исходящий поток (res) по одной, а не собирает весь архив
// в памяти — так что размер общего архива не ограничен ОЗУ сервера. Каждый
// отдельный файл при этом сжимается целиком в памяти (deflateRawSync), что
// для аватарок/картинок/коротких видео — не проблема.

const fs = require('fs');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ZIP хранит время в "DOS"-формате (2-секундная точность, годы от 1980).
function dosDateTime(date) {
  const time = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((date.getSeconds() >> 1) & 0x1F);
  const day = (((date.getFullYear() - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0xF) << 5) | (date.getDate() & 0x1F);
  return { time, day };
}

class ZipWriter {
  constructor(outStream) {
    this.out = outStream;
    this.offset = 0;
    this.entries = [];
    this.aborted = false;
    // Если клиент оборвал скачивание — прекращаем писать, но не падаем.
    outStream.on('close', () => { this.aborted = true; });
    outStream.on('error', () => { this.aborted = true; });
  }

  _write(buf) {
    this.offset += buf.length;
    if (this.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      if (this.out.write(buf)) resolve();
      else this.out.once('drain', resolve);
    });
  }

  // nameInZip — путь внутри архива (всегда с "/"). data — Buffer или путь к файлу на диске.
  async addFile(nameInZip, data) {
    if (this.aborted) return;
    let buf;
    try {
      buf = Buffer.isBuffer(data) ? data : fs.readFileSync(data);
    } catch (e) {
      return; // файл мог исчезнуть между чтением списка и чтением содержимого — пропускаем
    }

    const crc = crc32(buf);
    let method = 8; // deflate
    let compressed = zlib.deflateRawSync(buf, { level: 6 });
    if (compressed.length >= buf.length) { method = 0; compressed = buf; } // хранить как есть, если сжатие не помогло

    const nameBuf = Buffer.from(nameInZip.replace(/\\/g, '/'), 'utf8');
    const { time, day } = dosDateTime(new Date());
    const localOffset = this.offset;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);       // версия, нужная для распаковки
    header.writeUInt16LE(0, 6);        // флаги
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(day, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(buf.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);       // extra field length

    await this._write(header);
    await this._write(nameBuf);
    await this._write(compressed);

    this.entries.push({ nameBuf, crc, compressedSize: compressed.length, uncompressedSize: buf.length, localOffset, time, day, method });
  }

  async finalize() {
    const centralStart = this.offset;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4);   // version made by
      h.writeUInt16LE(20, 6);   // version needed
      h.writeUInt16LE(0, 8);    // flags
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.day, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.compressedSize, 20);
      h.writeUInt32LE(e.uncompressedSize, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt16LE(0, 30);   // extra length
      h.writeUInt16LE(0, 32);   // comment length
      h.writeUInt16LE(0, 34);   // disk number start
      h.writeUInt16LE(0, 36);   // internal attrs
      h.writeUInt32LE(0, 38);   // external attrs
      h.writeUInt32LE(e.localOffset, 42);
      await this._write(h);
      await this._write(e.nameBuf);
    }
    const centralSize = this.offset - centralStart;

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralStart, 16);
    end.writeUInt16LE(0, 20);
    await this._write(end);
  }
}

module.exports = { ZipWriter };
