'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

function genId(prefix = '') {
  return (prefix ? prefix + '_' : '') + crypto.randomBytes(9).toString('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function serializeCookie(name, value, opts = {}) {
  let str = `${name}=${encodeURIComponent(value)}`;
  if (opts.maxAge) str += `; Max-Age=${opts.maxAge}`;
  str += '; Path=/';
  str += '; HttpOnly';
  str += '; SameSite=Lax';
  return str;
}

// ---------- Шифрование чувствительных персональных данных (Riveo ID) ----------
// Паспортные данные и данные банковских карт (см. server.js, раздел Riveo)
// нельзя хранить в БД открытым текстом — файл БД лежит на диске сервера, и
// в отличие от паролей (которые нужно только ПРОВЕРЯТЬ — там уместен
// необратимый scryptSync-хэш выше), эти данные нужно потом показать
// владельцу обратно, поэтому используется обратимое шифрование:
// AES-256-GCM с ключом, который генерируется один раз при первом запуске
// и хранится рядом с базой (вне папки проекта — переживает обновления,
// см. тот же PERSIST_ROOT, что и в lib/db.js и у TURN_SECRET в server.js).
// GCM даёт не только конфиденциальность, но и проверку целостности
// (authTag) — если файл ключа подменят или блок повредится, расшифровка
// явно провалится, а не молча вернёт мусор.
const PERSIST_ROOT = process.env.ASTERIA_DATA_DIR || path.join(os.homedir(), '.asteria-data');
const RIVEO_KEY_PATH = path.join(PERSIST_ROOT, 'riveo-secret.txt');
function getOrCreateRiveoKey() {
  try {
    if (fs.existsSync(RIVEO_KEY_PATH)) return Buffer.from(fs.readFileSync(RIVEO_KEY_PATH, 'utf8').trim(), 'hex');
  } catch (e) {}
  const key = crypto.randomBytes(32);
  try {
    if (!fs.existsSync(PERSIST_ROOT)) fs.mkdirSync(PERSIST_ROOT, { recursive: true });
    fs.writeFileSync(RIVEO_KEY_PATH, key.toString('hex'));
  } catch (e) {}
  return key;
}
const RIVEO_KEY = getOrCreateRiveoKey();

// Шифрует произвольный JSON-совместимый объект → строка "iv:authTag:ciphertext" (hex).
function encryptSecret(plainObj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', RIVEO_KEY, iv);
  const plaintext = Buffer.from(JSON.stringify(plainObj), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

// Обратная операция. Возвращает null, если блок пуст/повреждён/от другого
// ключа — вызывающий код должен относиться к этому как к "данных нет", не падать.
function decryptSecret(blob) {
  if (!blob) return null;
  try {
    const [ivHex, tagHex, dataHex] = String(blob).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', RIVEO_KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch (e) {
    return null;
  }
}

module.exports = { genId, hashPassword, verifyPassword, parseCookies, serializeCookie, encryptSecret, decryptSecret };
