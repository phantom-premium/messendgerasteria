'use strict';
// Свой минимальный клиент Web Push (VAPID + шифрование пейлоада по RFC 8291),
// без внешних npm-пакетов (проект принципиально их не использует) — всё на
// встроенном node:crypto. Нужен, чтобы слать уведомления в закрытом Safari/
// PWA на iOS (и в фоне любого другого браузера): обычный `new Notification()`
// в app.js работает только пока страница жива во вкладке — реальный push
// от системы (через сервис Apple/Google/Mozilla) может разбудить Service
// Worker, даже когда сайт нигде не открыт.
//
// Что тут реализовано руками (обычно это делает пакет `web-push`):
//   1. VAPID (RFC 8292) — подписанный JWT, которым сервер представляется
//      push-службе (без него любая служба push сразу отклонит запрос).
//   2. aes128gcm-шифрование тела уведомления (RFC 8291/8188) — push-службы
//      (Apple/Google/Mozilla) не должны иметь возможность прочитать текст
//      уведомления, они только доставляют непрозрачный зашифрованный блок
//      до браузера, который расшифровывает его уже на устройстве.
const crypto = require('crypto');
const https = require('https');
const http = require('http');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

// Генерирует новую пару ключей VAPID (один раз на весь сервер, хранится в
// PERSIST_ROOT — см. loadOrCreateVapidKeys в server.js). Публичный ключ
// (65 байт, несжатая точка P-256) отдаётся браузеру при подписке —
// applicationServerKey в pushManager.subscribe().
function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const privJwk = privateKey.export({ format: 'jwk' });
  const pubRaw = Buffer.concat([Buffer.from([0x04]), fromB64url(pubJwk.x), fromB64url(pubJwk.y)]);
  return { publicKey: b64url(pubRaw), privateKey: b64url(fromB64url(privJwk.d)) };
}

function vapidPrivateKeyObject(vapidPrivateKeyB64url, vapidPublicKeyB64url) {
  const pubRaw = fromB64url(vapidPublicKeyB64url);
  const x = pubRaw.slice(1, 33);
  const y = pubRaw.slice(33, 65);
  const d = fromB64url(vapidPrivateKeyB64url);
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y), d: b64url(d) }, format: 'jwk' });
}

// JWT, подписанный приватным VAPID-ключом сервера (ES256, "сырая" подпись
// r||s фиксированной длины — именно её ждёт JOSE/JWT, а не DER, который
// node отдаёт по умолчанию, поэтому dsaEncoding: 'ieee-p1363').
function buildVapidAuthHeader(endpoint, vapidKeys, subject) {
  const { origin } = new URL(endpoint);
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud: origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const keyObj = vapidPrivateKeyObject(vapidKeys.privateKey, vapidKeys.publicKey);
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: keyObj, dsaEncoding: 'ieee-p1363' });
  const jwt = `${unsigned}.${b64url(sig)}`;
  return `vapid t=${jwt}, k=${vapidKeys.publicKey}`;
}

// Шифрование тела уведомления по RFC 8291 (content-coding "aes128gcm",
// RFC 8188). subscriptionKeys — {p256dh, auth}, которые браузер отдаёт при
// pushManager.subscribe() и которые мы сохраняем в БД (см. /api/push/subscribe).
function encryptPayload(payloadBuf, subscriptionKeys) {
  const uaPublic = fromB64url(subscriptionKeys.p256dh); // 65 байт, публичный ключ браузера
  const authSecret = fromB64url(subscriptionKeys.auth); // 16 байт, секрет подписки

  const asECDH = crypto.createECDH('prime256v1');
  asECDH.generateKeys();
  const asPublic = asECDH.getPublicKey(); // одноразовый ключ сервера для этого конкретного уведомления
  const ecdhSecret = asECDH.computeSecret(uaPublic);

  const prkKey = crypto.createHmac('sha256', authSecret).update(ecdhSecret).digest();
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = crypto.createHmac('sha256', prkKey).update(Buffer.concat([keyInfo, Buffer.from([1])])).digest();

  const salt = crypto.randomBytes(16);
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  const cek = crypto.createHmac('sha256', prk)
    .update(Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).digest().slice(0, 16);
  const nonce = crypto.createHmac('sha256', prk)
    .update(Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).digest().slice(0, 12);

  const plaintext = Buffer.concat([payloadBuf, Buffer.from([2])]); // 0x02 — признак последней (и единственной) записи
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096, 0);
  const idlen = Buffer.from([asPublic.length]);
  const header = Buffer.concat([salt, recordSize, idlen, asPublic]);
  return Buffer.concat([header, ciphertext, tag]);
}

// Отправляет одно push-уведомление в службу push (Apple/Google/Mozilla —
// определяется по домену subscription.endpoint, сама подписка это уже
// закодировала, нам разбираться не нужно). Возвращает {statusCode, body} —
// вызывающий код (server.js) сам решает, что делать с 404/410 (подписка
// больше не существует — значит нужно удалить её из БД).
function sendWebPush(subscription, payloadObj, vapidKeys, subject) {
  return new Promise((resolve, reject) => {
    let body, authHeader;
    try {
      const payloadBuf = Buffer.from(JSON.stringify(payloadObj), 'utf8');
      body = encryptPayload(payloadBuf, subscription.keys);
      authHeader = buildVapidAuthHeader(subscription.endpoint, vapidKeys, subject);
    } catch (e) {
      // ВАЖНО: шифрование (encryptPayload) выполняется синхронно и может
      // бросить исключение ДО того, как что-либо асинхронное запущено —
      // если не поймать его здесь, оно вылетит из sendWebPush() наружу
      // мимо .then()/.catch() у вызывающего кода (именно так раньше падала
      // вся обработка WS-сообщения при ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY).
      reject(e);
      return;
    }
    const u = new URL(subscription.endpoint);
    const mod = u.protocol === 'http:' ? http : https;
    const options = {
      method: 'POST',
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Content-Length': body.length,
        'TTL': '60',
        'Urgency': 'high',
        'Authorization': authHeader,
      },
    };
    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { generateVapidKeys, buildVapidAuthHeader, encryptPayload, sendWebPush, b64url, fromB64url };
