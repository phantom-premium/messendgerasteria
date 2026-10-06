// Минимальный STUN/TURN-сервер без внешних зависимостей (RFC 5389 / RFC 5766,
// только то, что реально нужно браузерному WebRTC: Binding, Allocate,
// Refresh, CreatePermission, Send/Data indication, длительные "credentials").
//
// Зачем это вообще нужно: пока мессенджер жил в локальной сети, браузерам
// ничего не мешало соединяться напрямую (host-кандидаты по локальным IP).
// В глобальной сети между двумя обычными интернет-подключениями почти всегда
// стоит NAT, и одного STUN (который лишь узнаёт "снаружи" видимый адрес)
// часто недостаточно — если у одной из сторон "симметричный" NAT/файрвол,
// прямое соединение не устанавливается вообще, и звонок просто не соединяется.
// Проблема решается TURN-сервером: он выступает промежуточным ретранслятором
// трафика, когда прямая связь невозможна. Чтобы не тащить в проект внешние
// пакеты и не зависеть от сторонних сервисов, реализован свой TURN-сервер на
// голом `dgram`, тем же духом, что и свой WebSocket в minirt-ws.js.
'use strict';
const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');

const MAGIC_COOKIE = 0x2112a442;
const REALM = 'asteria';

// ---------- STUN message helpers (RFC 5389) ----------
const TYPES = {
  BINDING_REQUEST: 0x0001,
  BINDING_RESPONSE: 0x0101,
  ALLOCATE_REQUEST: 0x0003,
  ALLOCATE_RESPONSE: 0x0103,
  ALLOCATE_ERROR: 0x0113,
  REFRESH_REQUEST: 0x0004,
  REFRESH_RESPONSE: 0x0104,
  REFRESH_ERROR: 0x0114,
  CREATE_PERMISSION_REQUEST: 0x0008,
  CREATE_PERMISSION_RESPONSE: 0x0108,
  CREATE_PERMISSION_ERROR: 0x0118,
  SEND_INDICATION: 0x0016,
  DATA_INDICATION: 0x0017,
};

const ATTR = {
  MAPPED_ADDRESS: 0x0001,
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  UNKNOWN_ATTRIBUTES: 0x000a,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_RELAYED_ADDRESS: 0x0016,
  REQUESTED_TRANSPORT: 0x0019,
  XOR_PEER_ADDRESS: 0x0012,
  DATA: 0x0013,
  XOR_MAPPED_ADDRESS: 0x0020,
  LIFETIME: 0x000d,
  SOFTWARE: 0x8022,
};

function pad4(n) { return (4 - (n % 4)) % 4; }

function parseMessage(buf) {
  if (buf.length < 20) return null;
  const type = buf.readUInt16BE(0);
  const length = buf.readUInt16BE(2);
  const cookie = buf.readUInt32BE(4);
  if (cookie !== MAGIC_COOKIE) return null;
  const transactionId = buf.slice(8, 20);
  if (buf.length < 20 + length) return null;
  const attrs = {};
  let offset = 20;
  const end = 20 + length;
  while (offset + 4 <= end) {
    const attrType = buf.readUInt16BE(offset);
    const attrLen = buf.readUInt16BE(offset + 2);
    const valStart = offset + 4;
    if (valStart + attrLen > end) break;
    const value = buf.slice(valStart, valStart + attrLen);
    attrs[attrType] = value;
    offset = valStart + attrLen + pad4(attrLen);
  }
  return { type, transactionId, attrs, raw: buf };
}

function encodeAttr(type, value) {
  const len = value.length;
  const header = Buffer.alloc(4);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(len, 2);
  const padding = Buffer.alloc(pad4(len));
  return Buffer.concat([header, value, padding]);
}

function xorAddress(addr, port, transactionId) {
  // IPv4 only — достаточно для WebRTC-медиа в подавляющем большинстве случаев.
  const parts = addr.split('.').map(Number);
  const buf = Buffer.alloc(8);
  buf.writeUInt8(0, 0);
  buf.writeUInt8(0x01, 1); // family IPv4
  const xport = port ^ (MAGIC_COOKIE >>> 16);
  buf.writeUInt16BE(xport, 2);
  const cookieBuf = Buffer.alloc(4);
  cookieBuf.writeUInt32BE(MAGIC_COOKIE, 0);
  for (let i = 0; i < 4; i++) buf[4 + i] = parts[i] ^ cookieBuf[i];
  return buf;
}

function decodeXorAddress(buf) {
  if (!buf || buf.length < 8) return null;
  const family = buf.readUInt8(1);
  if (family !== 0x01) return null;
  const cookieBuf = Buffer.alloc(4);
  cookieBuf.writeUInt32BE(MAGIC_COOKIE, 0);
  const port = buf.readUInt16BE(2) ^ (MAGIC_COOKIE >>> 16);
  const octets = [0, 1, 2, 3].map((i) => buf[4 + i] ^ cookieBuf[i]);
  return { address: octets.join('.'), port };
}

function buildMessage(type, transactionId, attrList, integrityKey) {
  let attrsBuf = Buffer.concat(attrList.map((a) => encodeAttr(a.type, a.value)));
  if (integrityKey) {
    // MESSAGE-INTEGRITY считается так, как будто в length уже учтён сам
    // 24-байтовый атрибут (заголовок 4 + HMAC-SHA1 20 байт), но ничего после него.
    const lenWithMI = attrsBuf.length + 24;
    const header = Buffer.alloc(20);
    header.writeUInt16BE(type, 0);
    header.writeUInt16BE(lenWithMI, 2);
    header.writeUInt32BE(MAGIC_COOKIE, 4);
    transactionId.copy(header, 8);
    const toSign = Buffer.concat([header, attrsBuf]);
    const hmac = crypto.createHmac('sha1', integrityKey).update(toSign).digest();
    attrsBuf = Buffer.concat([attrsBuf, encodeAttr(ATTR.MESSAGE_INTEGRITY, hmac)]);
  }
  const header = Buffer.alloc(20);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(attrsBuf.length, 2);
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  transactionId.copy(header, 8);
  return Buffer.concat([header, attrsBuf]);
}

function verifyIntegrity(msg, key) {
  const mi = msg.attrs[ATTR.MESSAGE_INTEGRITY];
  if (!mi) return false;
  // Пересобираем заголовок так, будто сообщение заканчивалось сразу после
  // атрибута MESSAGE-INTEGRITY (см. RFC 5389 §15.4).
  const miOffsetInAttrs = msg.raw.indexOf(mi) - 4; // offset of attr header within full buffer
  const lenForSig = miOffsetInAttrs + 24 - 20;
  const header = Buffer.alloc(20);
  header.writeUInt16BE(msg.type, 0);
  header.writeUInt16BE(lenForSig, 2);
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  msg.transactionId.copy(header, 8);
  const body = msg.raw.slice(20, miOffsetInAttrs);
  const toSign = Buffer.concat([header, body]);
  const expected = crypto.createHmac('sha1', key).update(toSign).digest();
  return expected.length === mi.length && crypto.timingSafeEqual(expected, mi);
}

function errorAttr(code, reason) {
  const buf = Buffer.alloc(4 + Buffer.byteLength(reason));
  buf.writeUInt8(0, 0);
  buf.writeUInt8(0, 1);
  buf.writeUInt8(Math.floor(code / 100), 2);
  buf.writeUInt8(code % 100, 3);
  buf.write(reason, 4, 'utf8');
  return buf;
}

// ---------- TURN REST API-style credentials (как у coturn с use-auth-secret) ----------
// username = "<unix-время-истечения>:<id-пользователя>"
// credential (пароль) = base64(HMAC-SHA1(secret, username))
function generateTurnCredentials(secret, userId, ttlSeconds = 6 * 3600) {
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const username = `${expiry}:${userId}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential, ttl: ttlSeconds };
}

function isUsernameValid(username) {
  const idx = username.indexOf(':');
  if (idx === -1) return false;
  const expiry = parseInt(username.slice(0, idx), 10);
  if (!expiry || Number.isNaN(expiry)) return false;
  return expiry > Math.floor(Date.now() / 1000);
}

function longTermKey(username, password) {
  return crypto.createHash('md5').update(`${username}:${REALM}:${password}`).digest();
}

// ---------- Сервер ----------
// relayPortMin/relayPortMax: диапазон UDP-портов, из которого выбираются
// сокеты для РЕЛЕЯ (собственно медиапоток между звонящим и принимающим).
// Это НЕ то же самое, что `port` (3478) — тот используется только для
// служебного протокола STUN/TURN (Allocate/Refresh/...), а сам медиатрафик
// после успешной аллокации идёт через отдельный сокет на другом порту.
// Если не задать диапазон, каждый релей-сокет получает случайный
// эфемерный порт от ОС — такой порт невозможно заранее пробросить через
// файрвол/NAT/облачный security group, из-за чего Allocate успешно
// проходит (через 3478), а реальные пакеты медиа снаружи не доходят —
// звонок зависает на checking/connecting и обрывается по медиа-таймауту.
// С заданным диапазоном достаточно один раз пробросить эти порты целиком,
// как и сам 3478.
function createTurnServer({ secret, port = 3478, publicIp = null, relayPortMin = null, relayPortMax = null, log = () => {} }) {
  const sock = dgram.createSocket('udp4');
  const nonces = new Map(); // nonce -> createdAt (для простоты не привязываем к клиенту)
  const allocations = new Map(); // clientKey ("ip:port") -> { relaySocket, permissions: Set<ip>, timer }
  const usedRelayPorts = new Set();
  const hasRelayRange = Number.isInteger(relayPortMin) && Number.isInteger(relayPortMax) && relayPortMax >= relayPortMin;
  let relayPortCursor = hasRelayRange ? relayPortMin : 0;

  function clientKey(rinfo) { return `${rinfo.address}:${rinfo.port}`; }

  // Пытается забиндить relaySocket на порт из заданного диапазона (перебирая
  // его по кругу, пропуская уже занятые нами порты); если диапазон не задан,
  // весь диапазон занят, или что-то пошло не так — используем обычный
  // случайный порт как аварийный fallback (лучше рабочий звонок в локальной
  // сети/без файрвола, чем вообще никакого).
  function bindRelaySocket(relaySocket, onBound) {
    if (!hasRelayRange) { relaySocket.bind(0, onBound); return; }
    const total = relayPortMax - relayPortMin + 1;
    let attempts = 0;
    const tryNext = () => {
      if (attempts >= total) { relaySocket.bind(0, onBound); return; } // диапазон исчерпан
      const port = relayPortMin + ((relayPortCursor - relayPortMin + attempts) % total);
      attempts++;
      if (usedRelayPorts.has(port)) { tryNext(); return; }
      const onError = (e) => {
        relaySocket.removeListener('error', onError);
        if (e && e.code === 'EADDRINUSE') { tryNext(); return; }
        relaySocket.bind(0, onBound); // непредвиденная ошибка — тоже не блокируем звонок
      };
      relaySocket.once('error', onError);
      relaySocket.bind(port, () => {
        relaySocket.removeListener('error', onError);
        usedRelayPorts.add(port);
        relayPortCursor = port + 1;
        onBound();
      });
    };
    tryNext();
  }

  function freshNonce() {
    const nonce = crypto.randomBytes(16).toString('hex');
    nonces.set(nonce, Date.now());
    return nonce;
  }

  function send(msg, rinfo) {
    // ФИКС "звонки работают только в одном Wi-Fi": раньше клиент-серверная
    // часть TURN умела только UDP — а часть мобильных сетей и
    // корпоративных/публичных Wi-Fi блокируют исходящий UDP на
    // нестандартные порты целиком (обычный HTTP(S)-трафик по TCP при этом
    // спокойно проходит). Если оба собеседника были в одном Wi-Fi, прямое
    // P2P-соединение WebRTC находилось само, TURN вообще не требовался —
    // проблема с UDP-only TURN проявлялась только когда сети разные и
    // требуется реальный ретранслятор. Теперь при TCP-подключении клиента
    // пишем ответ в его сокет вместо dgram.send — см. handleTcpConnection
    // ниже, где rinfo.tcpSocket выставляется для TCP-клиентов.
    if (rinfo.tcpSocket) {
      try { rinfo.tcpSocket.write(msg); } catch (e) { /* сокет уже мог закрыться — не критично */ }
    } else {
      sock.send(msg, rinfo.port, rinfo.address);
    }
  }

  function challenge(type, transactionId, rinfo, errCode = 401, reason = 'Unauthorized') {
    const nonce = freshNonce();
    const msg = buildMessage(type, transactionId, [
      { type: ATTR.ERROR_CODE, value: errorAttr(errCode, reason) },
      { type: ATTR.REALM, value: Buffer.from(REALM) },
      { type: ATTR.NONCE, value: Buffer.from(nonce) },
    ]);
    send(msg, rinfo);
  }

  // Проверяет long-term credentials по нашей REST-схеме и возвращает
  // {ok, key, userId} — либо шлёт 401/438 сама и возвращает {ok:false}.
  function authenticate(msg, rinfo, requestType, respErrType) {
    const usernameBuf = msg.attrs[ATTR.USERNAME];
    const nonceBuf = msg.attrs[ATTR.NONCE];
    if (!usernameBuf || !nonceBuf || !msg.attrs[ATTR.MESSAGE_INTEGRITY]) {
      challenge(respErrType, msg.transactionId, rinfo);
      return { ok: false };
    }
    const username = usernameBuf.toString('utf8');
    const nonce = nonceBuf.toString('utf8');
    if (!nonces.has(nonce) || !isUsernameValid(username)) {
      challenge(respErrType, msg.transactionId, rinfo, 438, 'Stale Nonce');
      return { ok: false };
    }
    const userId = username.slice(username.indexOf(':') + 1);
    // Пересчитываем ожидаемый credential той же HMAC-схемой, что и при выдаче
    // (generateTurnCredentials), по фактическому username из запроса.
    const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
    const key = longTermKey(username, credential);
    if (!verifyIntegrity(msg, key)) {
      challenge(respErrType, msg.transactionId, rinfo, 401, 'Unauthorized');
      return { ok: false };
    }
    return { ok: true, key, userId };
  }

  function handleBinding(msg, rinfo) {
    const xored = xorAddress(rinfo.address, rinfo.port);
    const resp = buildMessage(TYPES.BINDING_RESPONSE, msg.transactionId, [
      { type: ATTR.XOR_MAPPED_ADDRESS, value: xored },
    ]);
    send(resp, rinfo);
  }

  function handleAllocate(msg, rinfo) {
    const auth = authenticate(msg, rinfo, TYPES.ALLOCATE_REQUEST, TYPES.ALLOCATE_ERROR);
    if (!auth.ok) return;
    const ck = clientKey(rinfo);
    let alloc = allocations.get(ck);
    if (!alloc) {
      const transport = rinfo.tcpSocket ? 'TCP' : 'UDP';
      // Ключевая строка для диагностики "звонки работают только в одном
      // Wi-Fi": видно прямо в логе сервера, какой пользователь и по какому
      // транспорту реально получил TURN-аллокацию (relay). Если у человека
      // с проблемным звонком тут вообще нет строки — TURN до него не
      // достучался никаким транспортом (см. ФИКС про TCP-фолбэк); если
      // есть только UDP — при блокировке UDP по пути звонок не пройдёт,
      // TCP-фолбэк должен был подключиться сам.
      log(`allocate: пользователь ${auth.userId}, ${rinfo.address}:${rinfo.port}, транспорт ${transport}`);
      const relaySocket = dgram.createSocket('udp4');
      alloc = { relaySocket, permissions: new Set(), key: auth.key, clientRinfo: rinfo, userId: auth.userId, transport, peersHeardFrom: new Set() };
      relaySocket.on('message', (data, peerInfo) => {
        if (!alloc.permissions.has(peerInfo.address)) {
          // ДИАГНОСТИКА: пакет пришёл на релей-сокет этого пользователя, но
          // CreatePermission для этого адреса ещё/уже не выдан — обычно
          // безобидная гонка (permission ещё не подтвердился), но если это
          // повторяется весь звонок — значит с той стороны реального
          // разрешения так и не случилось, и это стоит увидеть в логе, а не
          // тихо ронять пакеты, как раньше.
          log(`relay: пакет от ${peerInfo.address}:${peerInfo.port} к пользователю ${alloc.userId} ОТБРОШЕН — нет permission для этого адреса`);
          return;
        }
        // ДИАГНОСТИКА: первый реальный пакет медиапотока, дошедший через
        // релей от конкретного собеседника — печатаем один раз на пару
        // (пользователь, адрес пира), а не на каждый пакет (их сотни в
        // секунду). Если при разборе конкретного звонка этой строки нет
        // вообще ни для одной из сторон — значит пакеты до relay-сокета
        // сервера физически не дошли (проблема где-то между клиентом и
        // сервером, не в самом TURN); если она есть у одного собеседника, но
        // нет у другого — проблема именно в сети того, кто не слышен.
        if (!alloc.peersHeardFrom.has(peerInfo.address)) {
          alloc.peersHeardFrom.add(peerInfo.address);
          log(`relay: ПОШЁЛ реальный медиапоток — пользователь ${alloc.userId} получает данные от ${peerInfo.address}:${peerInfo.port}`);
        }
        const dataIndication = buildMessage(TYPES.DATA_INDICATION, crypto.randomBytes(12), [
          { type: ATTR.XOR_PEER_ADDRESS, value: xorAddress(peerInfo.address, peerInfo.port) },
          { type: ATTR.DATA, value: data },
        ]);
        send(dataIndication, alloc.clientRinfo);
      });
      bindRelaySocket(relaySocket, () => {
        allocations.set(ck, alloc);
        respondAllocateOk(msg, rinfo, alloc);
      });
      return;
    }
    respondAllocateOk(msg, rinfo, alloc);
  }

  function respondAllocateOk(msg, rinfo, alloc) {
    scheduleExpiry(alloc, clientKey(rinfo), 600);
    const relayPort = alloc.relaySocket.address().port;
    const resp = buildMessage(TYPES.ALLOCATE_RESPONSE, msg.transactionId, [
      { type: ATTR.XOR_RELAYED_ADDRESS, value: xorAddress(publicIp || rinfo.address, relayPort) },
      { type: ATTR.XOR_MAPPED_ADDRESS, value: xorAddress(rinfo.address, rinfo.port) },
      { type: ATTR.LIFETIME, value: uint32(600) },
    ], alloc.key);
    send(resp, rinfo);
  }

  function releaseRelayPort(alloc) {
    try {
      const p = alloc.relaySocket.address().port;
      usedRelayPorts.delete(p);
    } catch (e) { /* сокет уже мог быть закрыт — не критично */ }
  }

  function scheduleExpiry(alloc, ck, seconds) {
    if (alloc.timer) clearTimeout(alloc.timer);
    if (seconds <= 0) {
      releaseRelayPort(alloc);
      try { alloc.relaySocket.close(); } catch (e) {}
      allocations.delete(ck);
      return;
    }
    alloc.timer = setTimeout(() => {
      releaseRelayPort(alloc);
      try { alloc.relaySocket.close(); } catch (e) {}
      allocations.delete(ck);
    }, seconds * 1000);
  }

  function uint32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; }

  function handleRefresh(msg, rinfo) {
    const auth = authenticate(msg, rinfo, TYPES.REFRESH_REQUEST, TYPES.REFRESH_ERROR);
    if (!auth.ok) return;
    const ck = clientKey(rinfo);
    const alloc = allocations.get(ck);
    const lifetimeBuf = msg.attrs[ATTR.LIFETIME];
    const lifetime = lifetimeBuf ? lifetimeBuf.readUInt32BE(0) : 600;
    if (!alloc) {
      const resp = buildMessage(TYPES.REFRESH_RESPONSE, msg.transactionId, [
        { type: ATTR.LIFETIME, value: uint32(0) },
      ], auth.key);
      send(resp, rinfo);
      return;
    }
    scheduleExpiry(alloc, ck, lifetime);
    const resp = buildMessage(TYPES.REFRESH_RESPONSE, msg.transactionId, [
      { type: ATTR.LIFETIME, value: uint32(lifetime) },
    ], auth.key);
    send(resp, rinfo);
  }

  function handleCreatePermission(msg, rinfo) {
    const auth = authenticate(msg, rinfo, TYPES.CREATE_PERMISSION_REQUEST, TYPES.CREATE_PERMISSION_ERROR);
    if (!auth.ok) return;
    const ck = clientKey(rinfo);
    const alloc = allocations.get(ck);
    if (!alloc) {
      log(`createPermission: нет активной allocation для ${rinfo.address}:${rinfo.port} (пользователь ${auth.userId}) — клиент прислал CreatePermission раньше Allocate или allocation уже истекла`);
      challenge(TYPES.CREATE_PERMISSION_ERROR, msg.transactionId, rinfo, 437, 'Allocation Mismatch');
      return;
    }
    const peer = decodeXorAddress(msg.attrs[ATTR.XOR_PEER_ADDRESS]);
    if (peer) {
      alloc.permissions.add(peer.address);
      log(`createPermission: пользователь ${auth.userId} разрешил релей с ${peer.address}`);
    }
    const resp = buildMessage(TYPES.CREATE_PERMISSION_RESPONSE, msg.transactionId, [], auth.key);
    send(resp, rinfo);
  }

  function handleSendIndication(msg, rinfo) {
    const ck = clientKey(rinfo);
    const alloc = allocations.get(ck);
    if (!alloc) return;
    const peer = decodeXorAddress(msg.attrs[ATTR.XOR_PEER_ADDRESS]);
    const data = msg.attrs[ATTR.DATA];
    if (!peer || !data) return;
    if (!alloc.permissions.has(peer.address)) {
      // ДИАГНОСТИКА: клиент пытается отправить медиапакет через свой релей
      // адресату, для которого ещё нет CreatePermission — обычно это
      // означает, что CreatePermission с той стороны либо не пришёл, либо
      // ICE ещё не выбрал эту пару кандидатов. Разово логируем на пару,
      // чтобы не заспамить консоль на каждый RTP-пакет.
      if (!alloc.sendDropLogged) alloc.sendDropLogged = new Set();
      if (!alloc.sendDropLogged.has(peer.address)) {
        alloc.sendDropLogged.add(peer.address);
        log(`relay: пользователь ${alloc.userId} пытается слать на ${peer.address} без CreatePermission — пакет отброшен`);
      }
      return;
    }
    alloc.relaySocket.send(data, peer.port, peer.address);
  }

  // Общий диспетчер сообщений — используется и для UDP-датаграмм, и для
  // сообщений, разобранных из TCP-потока (см. handleTcpConnection ниже):
  // сам протокол STUN/TURN (структура сообщений, атрибуты) от транспорта
  // не зависит, отличается только то, как разбираются границы сообщений
  // (в UDP одна датаграмма = одно сообщение, в TCP нужно резать поток по
  // длине из заголовка, см. TcpMessageSplitter).
  function dispatchMessage(buf, rinfo) {
    let msg;
    try { msg = parseMessage(buf); } catch (e) { return; }
    if (!msg) return;
    switch (msg.type) {
      case TYPES.BINDING_REQUEST: return handleBinding(msg, rinfo);
      case TYPES.ALLOCATE_REQUEST: return handleAllocate(msg, rinfo);
      case TYPES.REFRESH_REQUEST: return handleRefresh(msg, rinfo);
      case TYPES.CREATE_PERMISSION_REQUEST: return handleCreatePermission(msg, rinfo);
      case TYPES.SEND_INDICATION: return handleSendIndication(msg, rinfo);
      default: return;
    }
  }

  sock.on('message', (buf, rinfo) => dispatchMessage(buf, rinfo));

  sock.on('error', (e) => log('TURN/STUN socket error: ' + e.message));

  // ---------- TCP-транспорт (тот же порт, тот же протокол) ----------
  // На том же TURN_PORT дополнительно слушаем TCP — многие сети (мобильные
  // операторы, часть публичных/корпоративных Wi-Fi) блокируют или душат
  // произвольный UDP-трафик наружу, но почти всегда пропускают TCP.
  // Формат сообщений STUN/TURN тот же самый что в UDP (20-байтный
  // заголовок + длина атрибутов) — просто в потоке TCP их нужно нарезать
  // самим по этой длине, границы датаграмм TCP не сохраняет.
  const tcpServer = net.createServer((socket) => {
    socket.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    const rinfo = { address: socket.remoteAddress ? socket.remoteAddress.replace('::ffff:', '') : '0.0.0.0', port: socket.remotePort, tcpSocket: socket };
    const ck = clientKey(rinfo);

    socket.on('data', (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      // Может прийти сразу несколько сообщений в одном TCP-пакете (или
      // одно сообщение — несколькими пакетами) — вычитываем всё, что уже
      // собралось целиком, а остаток оставляем ждать следующих данных.
      while (buffer.length >= 20) {
        const attrsLen = buffer.readUInt16BE(2);
        const totalLen = 20 + attrsLen;
        if (buffer.length < totalLen) break; // сообщение ещё не докачалось целиком
        dispatchMessage(buffer.slice(0, totalLen), rinfo);
        buffer = buffer.slice(totalLen);
      }
    });

    const cleanup = () => {
      // TCP-соединение оборвалось — считаем, что allocation (если она
      // была) больше не нужна: реальные TURN-клиенты в вебе (WebRTC) при
      // потере клиент-серверного соединения всё равно переустанавливают
      // его заново и делают новый Allocate, ждать истечения TTL смысла нет.
      const alloc = allocations.get(ck);
      if (alloc) {
        if (alloc.timer) clearTimeout(alloc.timer);
        releaseRelayPort(alloc);
        try { alloc.relaySocket.close(); } catch (e) {}
        allocations.delete(ck);
      }
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
  tcpServer.on('error', (e) => log('TURN/STUN TCP socket error: ' + e.message));

  return new Promise((resolve) => {
    let udpReady = false;
    let tcpReady = false;
    const maybeResolve = () => { if (udpReady && tcpReady) resolve(sock); };
    sock.bind(port, '0.0.0.0', () => { udpReady = true; maybeResolve(); });
    tcpServer.listen(port, '0.0.0.0', () => { tcpReady = true; maybeResolve(); });
  });
}

// Best-effort определение "внешнего" (публичного) IP-адреса сервера: шлём
// обычный STUN Binding Request на публичный STUN-сервер и смотрим, какой
// адрес он видит. Нужно только чтобы TURN сразу из коробки давал клиентам
// снаружи правильный relay-адрес; если запрос не удаётся (нет интернета,
// сервер полностью в закрытой сети) — просто возвращаем null, ничего не ломая.
function stunDiscover(host = 'stun.l.google.com', port = 19302, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      try { sock.close(); } catch (e) {}
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.once('error', () => { clearTimeout(timer); finish(null); });
    sock.once('message', (buf) => {
      clearTimeout(timer);
      try {
        const msg = parseMessage(buf);
        const xored = msg && (msg.attrs[ATTR.XOR_MAPPED_ADDRESS] || msg.attrs[ATTR.MAPPED_ADDRESS]);
        finish(xored ? decodeXorAddress(xored) : null);
      } catch (e) { finish(null); }
    });
    const txId = crypto.randomBytes(12);
    const req = buildMessage(TYPES.BINDING_REQUEST, txId, []);
    sock.send(req, port, host, (err) => { if (err) finish(null); });
  });
}

module.exports = { createTurnServer, generateTurnCredentials, stunDiscover, REALM };
