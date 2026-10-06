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

// ---------- Шифрование чувствительных данных ("на диске") ----------
// Общая часть для Riveo ID (паспорт/карта) и для текста сообщений (см. ниже) —
// AES-256-GCM с ключом, который генерируется один раз при первом запуске и
// хранится рядом с базой (вне папки проекта — переживает обновления, см. тот
// же PERSIST_ROOT, что и в lib/db.js и у TURN_SECRET в server.js). GCM даёт
// не только конфиденциальность, но и проверку целостности (authTag) — если
// файл ключа подменят или блок повредится, расшифровка явно провалится, а не
// молча вернёт мусор.
// У каждого назначения — СВОЙ файл ключа (а не общий для всего подряд): так
// компрометация одного ключа (например, случайно попавшего в бэкап или лог)
// не тянет за собой всё остальное сразу.
const PERSIST_ROOT = process.env.ASTERIA_DATA_DIR || path.join(os.homedir(), '.asteria-data');
function makeSecretBox(keyFileName) {
  const keyPath = path.join(PERSIST_ROOT, keyFileName);
  function getOrCreateKey() {
    try {
      if (fs.existsSync(keyPath)) return Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'hex');
    } catch (e) {}
    const key = crypto.randomBytes(32);
    try {
      if (!fs.existsSync(PERSIST_ROOT)) fs.mkdirSync(PERSIST_ROOT, { recursive: true });
      fs.writeFileSync(keyPath, key.toString('hex'));
    } catch (e) {}
    return key;
  }
  const KEY = getOrCreateKey();
  // Шифрует произвольный JSON-совместимый объект → строка "iv:authTag:ciphertext" (hex).
  function encrypt(plainObj) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
    const plaintext = Buffer.from(JSON.stringify(plainObj), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
  }
  // Обратная операция. Возвращает null, если блок пуст/повреждён/от другого
  // ключа — вызывающий код должен относиться к этому как к "данных нет", не падать.
  function decrypt(blob) {
    if (!blob) return null;
    try {
      const [ivHex, tagHex, dataHex] = String(blob).split(':');
      const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
      return JSON.parse(decrypted.toString('utf8'));
    } catch (e) {
      return null;
    }
  }
  return { encrypt, decrypt };
}

// Паспорт/карта (Riveo ID) — свой ключ, как и раньше (riveo-secret.txt).
const riveoBox = makeSecretBox('riveo-secret.txt');
function encryptSecret(plainObj) { return riveoBox.encrypt(plainObj); }
function decryptSecret(blob) { return riveoBox.decrypt(blob); }

// ---------- Текст сообщений: свой ключ у КАЖДОЙ переписки ----------
// Раньше все сообщения шифровались одним общим ключом на всё приложение.
// Теперь у каждой переписки — собственный, отдельный от всех остальных
// AES-256-ключ, так что компрометация ключа одного диалога не даёт прочитать
// остальные. Хранить и бэкапить отдельный случайный ключ на каждую из
// потенциально тысяч переписок было бы неудобно и рискованно (потерялся файл
// с одним ключом — потеряна одна переписка возможности его создать заново
// нет). Вместо этого ключ переписки ДЕТЕРМИНИРОВАННО порождается из общего
// мастер-ключа сервера (messages-secret.txt) и id этой переписки:
//   ключ_переписки = HMAC-SHA256(мастер-ключ, id_переписки)
// Это стандартный приём (HKDF/HMAC-derivation) — зная мастер-ключ и id
// переписки, сервер в любой момент восстановит нужный ключ, но имея только
// ключ одной переписки, восстановить ни мастер-ключ, ни ключи других
// переписок нельзя (HMAC необратим).
const MESSAGES_MASTER_KEY_PATH = path.join(PERSIST_ROOT, 'messages-secret.txt');
function getOrCreateMessagesMasterKey() {
  try {
    if (fs.existsSync(MESSAGES_MASTER_KEY_PATH)) return Buffer.from(fs.readFileSync(MESSAGES_MASTER_KEY_PATH, 'utf8').trim(), 'hex');
  } catch (e) {}
  const key = crypto.randomBytes(32);
  try {
    if (!fs.existsSync(PERSIST_ROOT)) fs.mkdirSync(PERSIST_ROOT, { recursive: true });
    fs.writeFileSync(MESSAGES_MASTER_KEY_PATH, key.toString('hex'));
  } catch (e) {}
  return key;
}
const MESSAGES_MASTER_KEY = getOrCreateMessagesMasterKey();
// Старая версия (единый ключ на все переписки сразу) — оставлена только
// для чтения уже накопленных на её месте сообщений, см. decryptMessageText.
const legacyMessageBox = makeSecretBox('messages-secret.txt');

function deriveConversationKey(conversationId) {
  return crypto.createHmac('sha256', MESSAGES_MASTER_KEY).update(String(conversationId)).digest();
}
function conversationCipher(conversationId) {
  const key = deriveConversationKey(conversationId);
  function encrypt(plainObj) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plaintext = Buffer.from(JSON.stringify(plainObj), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
  }
  function decrypt(blob) {
    if (!blob) return null;
    try {
      const parts = String(blob).split(':');
      if (parts.length !== 3) return null;
      const [ivHex, tagHex, dataHex] = parts;
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
      return JSON.parse(decrypted.toString('utf8'));
    } catch (e) {
      return null;
    }
  }
  return { encrypt, decrypt };
}

// AES-GCM работает на аппаратном ускорении (AES-NI) почти на любом
// современном сервере — шифрование/расшифровка одного сообщения занимает
// микросекунды, так что это НЕ источник заметных тормозов на чтении истории
// чата, даже когда там сотни сообщений разом.
// text может быть undefined/null (не у всех типов сообщений есть текст) —
// нормализуем в '' перед шифрованием, чтобы decrypt всегда возвращал строку.
function encryptMessageText(conversationId, text) {
  return conversationCipher(conversationId).encrypt({ t: text == null ? '' : String(text) });
}
// Порядок проверки при чтении (важно для обратной совместимости с уже
// накопленными сообщениями трёх разных "эпох"):
//   1) новый ключ, свой у этой переписки — то, чем шифруем начиная с этой версии;
//   2) старый общий ключ на все переписки — то, чем шифровали версией раньше;
//   3) если ни один не подошёл — это сообщение из ДО того, как шифрование
//      вообще появилось: оно хранится открытым текстом как есть, отдаём его
//      без изменений, а не молча "теряем" (было именно так: старые сообщения
//      переставали читаться, потому что расшифровка их текста как шифроблока
//      просто проваливалась).
function decryptMessageText(conversationId, blob) {
  if (!blob) return '';
  const viaConversationKey = conversationCipher(conversationId).decrypt(blob);
  if (viaConversationKey) return viaConversationKey.t;
  const viaLegacyKey = legacyMessageBox.decrypt(blob);
  if (viaLegacyKey) return viaLegacyKey.t;
  return String(blob);
}
// Публичный, безопасный для показа "отпечаток" ключа переписки — не сам
// ключ (его наружу отдавать нельзя, это и есть секрет шифрования), а хэш от
// него с отдельной меткой: по отпечатку нельзя восстановить ключ, но два
// участника переписки, увидев в профиле друг друга одинаковый отпечаток,
// могут убедиться, что оба обращаются к одной и той же (не подменённой)
// переписке — как номер безопасности в Signal или ключ шифрования в
// секретных чатах Telegram.
function conversationKeyFingerprint(conversationId) {
  const key = deriveConversationKey(conversationId);
  const hash = crypto.createHash('sha256').update(Buffer.concat([Buffer.from('fingerprint:'), key])).digest('hex').toUpperCase();
  return hash.slice(0, 32).match(/.{1,4}/g).join(' ');
}

module.exports = {
  genId, hashPassword, verifyPassword, parseCookies, serializeCookie,
  encryptSecret, decryptSecret, encryptMessageText, decryptMessageText, conversationKeyFingerprint,
};
