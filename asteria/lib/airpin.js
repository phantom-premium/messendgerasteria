'use strict';
/**
 * AirPin — серверная часть (мост интернет <-> mesh-сеть без интернета).
 *
 * Сервер в AirPin НЕ участвует в mesh. Он только:
 *  1) раздаёт авторизованным клиентам ключи (GET /api/airpin/keys);
 *  2) принимает «конверты» от устройства-моста (POST /api/airpin/ingest),
 *     проверяет подпись отправителя, расшифровывает и создаёт обычное сообщение;
 *  3) в ответ на тот же запрос отдаёт мосту новые сообщения для устройств,
 *     которые прямо сейчас сидят в mesh без интернета («downlink»).
 *
 * КРИПТО (протокол v1)
 *   masterSecret   — 32 случайных байта в PERSIST_ROOT/airpin-master.key
 *   convKey(c)     = HMAC-SHA256(master, "conv:" + convId)   — ключ чата
 *   userKey(u)     = HMAC-SHA256(master, "user:" + userId)   — ключ автора
 *   Конверт:
 *     { v:1, id, c, f, t, ttl, n, d, s }
 *       id  — уникальный id конверта (клиент генерирует 16 байт -> base64url)
 *       c   — conversationId, f — userId автора, t — время создания (мс)
 *       n   — IV AES-GCM (12 байт, base64)
 *       d   — шифртекст+тег AES-256-GCM под convKey, AAD = id|c|f|t
 *       s   — HMAC-SHA256(userKey(f), id|c|f|t|n|d), base64
 *   Чужие телефоны-ретрансляторы НЕ могут прочитать текст (нет convKey) и
 *   не могут подделать подпись (нет userKey автора). Участники чата, у которых
 *   есть convKey, читают конверт напрямую по mesh (офлайн-доставка).
 *   Известное ограничение: подпись проверяет только сервер, участники чата
 *   доверяют полю f (см. README, раздел «Что доделать»).
 *
 * Сообщения от клиента: { mt:'text'|'location', c:string, r:replyToId|null, m:meta|null }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ENVELOPE_BYTES = 16 * 1024;
const MAX_PLAINTEXT_CHARS = 4000;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;      // конверты старше недели не принимаем
const FUTURE_SKEW_MS = 10 * 60 * 1000;        // часы отправителя могут спешить на 10 мин
const SEEN_TTL_MS = 14 * 24 * 3600 * 1000;
const SEEN_MAX = 50000;
const ALLOWED_TYPES = new Set(['text', 'location']);

function b64(buf) { return Buffer.from(buf).toString('base64'); }
function unb64(s) { return Buffer.from(String(s), 'base64'); }

function createAirPin(persistRoot) {
  const masterPath = path.join(persistRoot, 'airpin-master.key');
  const seenPath = path.join(persistRoot, 'airpin-seen.json');

  let master;
  try {
    master = fs.readFileSync(masterPath);
    if (master.length !== 32) throw new Error('bad length');
  } catch (e) {
    master = crypto.randomBytes(32);
    try { fs.mkdirSync(persistRoot, { recursive: true }); } catch (e2) { /* ignore */ }
    fs.writeFileSync(masterPath, master, { mode: 0o600 });
  }

  const hmac = (label, id) => crypto.createHmac('sha256', master).update(label + ':' + id).digest();
  const convKey = (convId) => hmac('conv', convId);
  const userKey = (userId) => hmac('user', userId);

  // ---- «уже видели» (дедупликация конвертов), переживает перезапуск ----
  const seen = new Map(); // envelopeId -> ts
  try {
    const raw = JSON.parse(fs.readFileSync(seenPath, 'utf8'));
    if (Array.isArray(raw)) raw.forEach(([id, ts]) => seen.set(id, ts));
  } catch (e) { /* первый запуск */ }
  let saveTimer = null;
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const now = Date.now();
      for (const [id, ts] of seen) if (now - ts > SEEN_TTL_MS) seen.delete(id);
      while (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value);
      fs.writeFile(seenPath, JSON.stringify([...seen]), () => {});
    }, 3000);
    if (saveTimer.unref) saveTimer.unref();
  }
  const wasSeen = (id) => seen.has(id);
  function markSeen(id) { seen.set(id, Date.now()); scheduleSave(); }

  const aad = (e) => Buffer.from(`${e.id}|${e.c}|${e.f}|${e.t}`, 'utf8');
  const sigInput = (e) => Buffer.from(`${e.id}|${e.c}|${e.f}|${e.t}|${e.n}|${e.d}`, 'utf8');

  function seal(plain, { id, convId, fromId, t, ttl }) {
    const e = { v: 1, id, c: convId, f: fromId, t, ttl: ttl == null ? 12 : ttl, n: '', d: '', s: '' };
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', convKey(convId), iv);
    cipher.setAAD(aad(e));
    const ct = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final(), cipher.getAuthTag()]);
    e.n = b64(iv);
    e.d = b64(ct);
    e.s = b64(crypto.createHmac('sha256', userKey(fromId)).update(sigInput(e)).digest());
    return e;
  }

  /** Возвращает { ok:true, plain } или { ok:false, reason }. Не проверяет членство в чате — это делает вызывающий. */
  function open(e, now = Date.now()) {
    try {
      if (!e || e.v !== 1) return { ok: false, reason: 'version' };
      if (typeof e.id !== 'string' || e.id.length < 8 || e.id.length > 64) return { ok: false, reason: 'id' };
      if (typeof e.c !== 'string' || typeof e.f !== 'string' || typeof e.n !== 'string' || typeof e.d !== 'string' || typeof e.s !== 'string') return { ok: false, reason: 'shape' };
      if (!Number.isFinite(e.t)) return { ok: false, reason: 'time' };
      if (e.t > now + FUTURE_SKEW_MS || e.t < now - MAX_AGE_MS) return { ok: false, reason: 'expired' };
      if (JSON.stringify(e).length > MAX_ENVELOPE_BYTES) return { ok: false, reason: 'size' };

      const want = crypto.createHmac('sha256', userKey(e.f)).update(sigInput(e)).digest();
      const got = unb64(e.s);
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, reason: 'signature' };

      const raw = unb64(e.d);
      if (raw.length < 17) return { ok: false, reason: 'shape' };
      const decipher = crypto.createDecipheriv('aes-256-gcm', convKey(e.c), unb64(e.n));
      decipher.setAAD(aad(e));
      decipher.setAuthTag(raw.subarray(raw.length - 16));
      const plain = JSON.parse(Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString('utf8'));

      if (!plain || !ALLOWED_TYPES.has(plain.mt)) return { ok: false, reason: 'type' };
      if (typeof plain.c !== 'string' || plain.c.length > MAX_PLAINTEXT_CHARS) return { ok: false, reason: 'content' };
      return { ok: true, plain };
    } catch (err) {
      return { ok: false, reason: 'crypto' };
    }
  }

  return { convKey, userKey, seal, open, wasSeen, markSeen, ALLOWED_TYPES };
}

module.exports = { createAirPin };
