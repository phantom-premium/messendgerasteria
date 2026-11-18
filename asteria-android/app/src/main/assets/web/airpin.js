/* AirPin — клиентская часть связи без интернета (mesh через соседние телефоны).
 *
 * Схема (подробно — README, раздел «AirPin»):
 *   страница (этот файл): ключи, шифрование, очередь «исходящих», расшифровка входящих
 *        ↕ window.AsteriaNotify.airpin*  /  window.AirPinNative.onEvent
 *   Android AirPinService: Nearby-mesh, ретрансляция, мост «интернет ↔ mesh»
 *        ↕ POST /api/airpin/ingest
 *   сервер: проверка подписи, создание обычного сообщения, раздача соседям без интернета
 *
 * Конверт и криптография совпадают с lib/airpin.js на сервере:
 *   AES-256-GCM под ключом чата, AAD = id|c|f|t; подпись HMAC-SHA256 ключом автора
 *   по id|c|f|t|n|d. Ключи выдаёт сервер (GET /api/airpin/keys) пока интернет есть.
 */
(function () {
  'use strict';

  // Нативный Nearby-mesh есть только в новых сборках Android-приложения. На сайте и в старых
  // версиях приложения (где моста airpin* нет) AirPin работает в «веб-режиме»: сообщения без
  // интернета шифруются, ждут в очереди и уходят на сервер сами, как только связь вернётся.
  const NATIVE_METHODS = ['airpinStart', 'airpinStop', 'airpinAttach', 'airpinSend', 'airpinConsumed', 'airpinSince', 'airpinAvailable'];
  const native = (window.AsteriaNotify && NATIVE_METHODS.every((m) => typeof window.AsteriaNotify[m] === 'function')) ? window.AsteriaNotify : null;
  const AP = (window.AirPin = {});
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const subtle = window.crypto && window.crypto.subtle;

  const KEYS_MAX_AGE = 6 * 3600 * 1000;
  const SEEN_MAX = 800;
  const OUTBOX_MAX = 200;

  let status = { running: false, internet: false, peers: [], pending: 0 };
  let keys = null;                 // { userId, userKey, convKeys:{}, fetchedAt }
  const cryptoCache = { conv: {}, user: null };
  let outbox = [];                 // [{id, convId, env, local:{...}, state:'queued'|'server'}]
  let seen = [];                   // id'ы конвертов, уже обработанных страницей

  // `state` и `api` в app.js объявлены через const/function верхнего уровня: `state` НЕ доступен как
  // window.state, поэтому обращаемся к нему напрямую (через typeof — страница может быть ещё не готова).
  const appState = () => (typeof state !== 'undefined' ? state : null);
  const myId = () => { const st = appState(); return (st && st.user && st.user.id) || null; };
  const lsKey = (n) => 'airpin.' + n + '.' + (myId() || '_');
  function lsGet(n, d) { try { const v = localStorage.getItem(lsKey(n)); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function lsSet(n, v) { try { localStorage.setItem(lsKey(n), JSON.stringify(v)); } catch (e) { /* квота */ } }

  const b64 = (buf) => { let s = ''; const a = new Uint8Array(buf); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); };
  const unb64 = (s) => { const bin = atob(s); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; };
  const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const serverReachable = () => { const st = appState(); return !!(st && st.ws && st.ws.readyState === 1); };

  /* ---------------- ключи ---------------- */

  function loadState() {
    keys = lsGet('keys', null);
    outbox = lsGet('outbox', []);
    seen = lsGet('seen', []);
    cryptoCache.conv = {}; cryptoCache.user = null;
  }
  const saveOutbox = () => lsSet('outbox', outbox.slice(-OUTBOX_MAX));
  const saveSeen = () => lsSet('seen', seen.slice(-SEEN_MAX));

  async function refreshKeys(force) {
    if (!myId() || !serverReachable()) return !!keys;
    const st = appState();
    const missing = keys && ((st && st.conversations) || []).some((c) => !keys.convKeys[c.id]);
    if (!force && keys && !missing && Date.now() - keys.fetchedAt < KEYS_MAX_AGE) return true;
    try {
      const r = await api('/api/airpin/keys');
      keys = { userId: r.userId, userKey: r.userKey, convKeys: r.convKeys || {}, fetchedAt: Date.now() };
      cryptoCache.conv = {}; cryptoCache.user = null;
      lsSet('keys', keys);
      return true;
    } catch (e) { return !!keys; }
  }

  async function convCryptoKey(convId) {
    if (!keys || !keys.convKeys[convId]) return null;
    if (!cryptoCache.conv[convId]) cryptoCache.conv[convId] = await subtle.importKey('raw', unb64(keys.convKeys[convId]), 'AES-GCM', false, ['encrypt', 'decrypt']);
    return cryptoCache.conv[convId];
  }
  async function userHmacKey() {
    if (!keys) return null;
    if (!cryptoCache.user) cryptoCache.user = await subtle.importKey('raw', unb64(keys.userKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return cryptoCache.user;
  }

  /* ---------------- конверты ---------------- */

  async function seal(plain, convId, id, t) {
    const ck = await convCryptoKey(convId);
    const uk = await userHmacKey();
    if (!ck || !uk) throw new Error('нет ключей AirPin');
    const from = myId();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`${id}|${convId}|${from}|${t}`) }, ck, enc.encode(JSON.stringify(plain)));
    const env = { v: 1, id, c: convId, f: from, t, ttl: 12, n: b64(iv), d: b64(ct), s: '' };
    const sig = await subtle.sign('HMAC', uk, enc.encode(`${id}|${convId}|${from}|${t}|${env.n}|${env.d}`));
    env.s = b64(sig);
    return env;
  }

  async function open(env) {
    try {
      const ck = await convCryptoKey(env.c);
      if (!ck) return null; // чат не наш — конверт просто ретранслируем
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.n), additionalData: enc.encode(`${env.id}|${env.c}|${env.f}|${env.t}`) }, ck, unb64(env.d));
      return JSON.parse(dec.decode(pt));
    } catch (e) { return null; }
  }

  /* ---------------- отправка без интернета ---------------- */

  // В веб-режиме (без нативного моста) очередь включена по умолчанию, пока пользователь её не выключил;
  // в приложении с Nearby — только после явного включения.
  const isEnabled = () => { const v = lsGet('enabled', null); return v === null ? !native : !!v; };

  function canHandle(convId, msgType) {
    return !!(subtle && keys && keys.convKeys[convId] && isEnabled() && (msgType === 'text' || msgType === 'location'));
  }

  /**
   * Вызывается из sendWSMessage, когда сервер недоступен.
   * @returns {boolean} true — сообщение принято AirPin (показано в чате, уйдёт по mesh).
   */
  AP.handleOfflineSend = function (convId, msgType, content, meta, replyToId) {
    if (!canHandle(convId, msgType)) return false;
    const rnd = crypto.getRandomValues(new Uint8Array(16));
    const id = b64url(rnd);
    const t = Date.now();
    const plain = { mt: msgType, c: content || '', r: replyToId || null, m: msgType === 'location' ? (meta || null) : null };
    const local = {
      id: 'airpin:' + id, conversationId: convId, senderId: myId(), msgType, content: content || '',
      mediaUrl: null, meta: Object.assign({}, msgType === 'location' ? meta : null, { airpin: true, airpinId: id, airpinState: 'queued' }),
      replyToId: replyToId || null, createdAt: t,
    };
    const item = { id, convId, env: null, local, state: 'queued' };
    outbox.push(item);
    showLocal(local);
    seal(plain, convId, id, t).then((env) => {
      item.env = env;
      saveOutbox();
      pushToNative(item);
      flushViaServer();
    }).catch(() => { outbox = outbox.filter((x) => x !== item); saveOutbox(); removeLocal(local.id); if (typeof showToast === 'function') showToast('AirPin: не удалось отправить'); });
    if (typeof showToast === 'function' && !AP._toldOnce) { AP._toldOnce = true; showToast('📡 Нет интернета — отправлено через AirPin'); }
    return true;
  };

  function showLocal(m) {
    if (!state.messages[m.conversationId]) state.messages[m.conversationId] = [];
    state.messages[m.conversationId].push(m);
    if (typeof bumpConversation === 'function') bumpConversation(m.conversationId, m);
    if (state.activeConvId === m.conversationId && typeof appendMessageBubble === 'function') { appendMessageBubble(m); decorate(m); }
    else if (typeof renderConvList === 'function') renderConvList();
  }

  function removeLocal(msgId) {
    Object.keys(state.messages).forEach((cid) => {
      const list = state.messages[cid];
      const i = list.findIndex((x) => x.id === msgId);
      if (i !== -1) list.splice(i, 1);
    });
    document.querySelectorAll('.msg-row[data-msg-id="' + msgId + '"]').forEach((r) => r.remove());
  }

  function decorate(m) {
    // Маленькая отметка «📡» в пузыре: сообщение прошло/идёт через AirPin.
    const row = document.querySelector('.msg-row[data-msg-id="' + m.id + '"]');
    if (!row) return;
    const bubble = row.querySelector('.bubble');
    if (!bubble || bubble.querySelector('.airpin-badge')) return;
    const b = document.createElement('span');
    b.className = 'airpin-badge';
    b.style.cssText = 'font-size:11px;opacity:.7;margin-left:6px;white-space:nowrap';
    b.textContent = m.meta && m.meta.airpinState === 'server' ? '📡✓' : '📡';
    b.title = 'AirPin — доставка без интернета';
    bubble.appendChild(b);
  }

  function pushToNative(item) {
    if (native && item.env && item.state === 'queued') { try { native.airpinSend(JSON.stringify(item.env)); } catch (e) { /* сервис не запущен */ } }
  }

  /** Есть связь с сервером — сами заливаем накопленное (то же, что делает мост). */
  async function flushViaServer() {
    if (!serverReachable()) return;
    const pend = outbox.filter((x) => x.state === 'queued' && x.env);
    if (!pend.length) return;
    try {
      const r = await api('/api/airpin/ingest', { method: 'POST', body: { envelopes: pend.map((x) => x.env), peers: [] } });
      markServer(Object.keys(r.results || {}));
    } catch (e) { /* повторим при следующем подключении */ }
  }

  function markServer(ids) {
    const set = new Set(ids);
    let changed = false;
    outbox.forEach((x) => { if (set.has(x.id) && x.state !== 'server') { x.state = 'server'; x.local.meta.airpinState = 'server'; changed = true; } });
    if (changed) saveOutbox();
  }

  /* ---------------- приём ---------------- */

  async function onEnvelope(env) {
    try {
      if (!env || !env.id || !env.c || !env.f) return;
      if (env.f === myId() || seen.includes(env.id)) return native && native.airpinConsumed(env.id);
      const plain = await open(env);
      if (native) native.airpinConsumed(env.id);
      seen.push(env.id); saveSeen();
      if (!plain) return;
      const mid = env.dl ? env.id : null;           // downlink — id уже серверный
      const airId = plain.aid || (env.dl ? null : env.id);
      // уже есть такое сообщение (пришло по сети или раньше по mesh)?
      const have = (state.messages[env.c] || []).some((x) => x.id === mid || (airId && x.meta && x.meta.airpinId === airId));
      if (have) return;
      const m = {
        id: mid || ('airpin:' + env.id), conversationId: env.c, senderId: env.f, msgType: plain.mt, content: plain.c || '',
        mediaUrl: null, meta: Object.assign({}, plain.mt === 'location' ? plain.m : null, { airpin: true, airpinId: airId || env.id, airpinState: 'mesh' }),
        replyToId: plain.r || null, createdAt: env.t,
      };
      if (typeof handleWSEvent === 'function') handleWSEvent({ type: 'message', message: m });
      if (state.activeConvId === env.c) decorate(m);
      if (native) native.airpinSince(env.t);
    } catch (e) { /* битый конверт игнорируем */ }
  }

  /** Вызывается из handleWSEvent перед добавлением настоящего серверного сообщения. */
  AP.onServerMessage = function (msg) {
    const aid = msg && msg.meta && msg.meta.airpinId;
    if (!aid) return;
    const list = state.messages[msg.conversationId] || [];
    const local = list.find((x) => x.id !== msg.id && x.meta && x.meta.airpinId === aid);
    if (local) removeLocal(local.id);
    markServer([aid]);
    if (!seen.includes(aid)) { seen.push(aid); saveSeen(); }
  };

  /** Вызывается после загрузки истории чата с сервера: убираем дубли, возвращаем ещё не дошедшие сообщения. */
  AP.mergeHistory = function (convId, serverList) {
    const aids = new Set(serverList.map((m) => m.meta && m.meta.airpinId).filter(Boolean));
    const extra = outbox.filter((x) => x.convId === convId && !aids.has(x.id) && x.state === 'queued').map((x) => x.local);
    return extra.length ? serverList.concat(extra) : serverList;
  };

  /* ---------------- события от Android ---------------- */

  window.AirPinNative = {
    onEvent(type, json) {
      let data; try { data = JSON.parse(json); } catch (e) { return; }
      if (type === 'env') onEnvelope(data);
      else if (type === 'ack') { markServer(data); }
      else if (type === 'status') {
        const wasRunning = status.running;
        status = data; renderRow();
        if (status.running && !wasRunning) outbox.filter((x) => x.state === 'queued').forEach(pushToNative);
      }
    },
  };

  /* ---------------- включение/выключение и строка в настройках ---------------- */

  AP.enable = async function () {
    if (!subtle) { alert('AirPin требует защищённого соединения (HTTPS).'); return; }
    if (native && !native.airpinAvailable()) {
      // нет Google Play Services — mesh недоступен, но очередь отправки всё равно работает
      alert('Нужны Google Play Services (Nearby Connections). На этом устройстве их нет — AirPin будет работать как очередь: сообщения уйдут, когда появится интернет.');
    }
    if (!(await refreshKeys(true))) { alert('Чтобы включить AirPin, нужен интернет — приложение один раз загрузит ключи шифрования.'); return; }
    lsSet('enabled', true);
    if (native && native.airpinAvailable()) native.airpinStart(myId(), Number(lsGet('since', 0)) || 0);
    renderRow();
  };
  AP.disable = function () { lsSet('enabled', false); if (native) native.airpinStop(); status = { running: false, internet: false, peers: [], pending: 0 }; renderRow(); };

  function rowText() {
    if (!isEnabled()) return 'Выключено';
    const queued = outbox.filter((x) => x.state === 'queued').length;
    if (!native) {
      // веб-режим: соседей нет, только очередь
      return serverReachable() ? 'Включено' + (queued ? ` · в очереди: ${queued}` : '') : 'Нет сети' + (queued ? ` · в очереди: ${queued}` : '');
    }
    if (!status.running) return 'Запускается…';
    const n = (status.peers || []).length;
    const bridge = status.internet ? ' · мост' : '';
    return (n ? `Рядом: ${n}` : 'Нет устройств рядом') + bridge + (status.pending ? ` · в очереди: ${status.pending}` : '');
  }

  function renderRow() {
    const el = document.getElementById('airpinRowValue');
    if (el) el.textContent = rowText();
    try { window.dispatchEvent(new Event('airpin-status')); } catch (e) { /* ignore */ }
  }

  /** Состояние для плашки «Ожидание сети» (см. offline.js). */
  AP.statusInfo = function () {
    return {
      ready: !!AP._ready,
      enabled: isEnabled(),
      native: !!native,
      running: !!status.running,
      peers: (status.peers || []).length,
      bridge: !!status.internet,
      queued: outbox.filter((x) => x.state === 'queued').length + (status.pending || 0),
      hasKeys: !!keys,
    };
  };

  function installRow() {
    if (document.getElementById('airpinRow')) return;
    const logout = document.getElementById('logoutBtn');
    const group = logout && logout.closest('.settings-list-group');
    if (!group) return;
    const wrap = document.createElement('div');
    wrap.className = 'settings-list-group';
    wrap.innerHTML = '<button class="settings-list-item" id="airpinRow"><span class="sli-icon sli-icon-skyblue"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1.9"/><path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.3 5.3a9.5 9.5 0 0 0 0 13.4M18.7 5.3a9.5 9.5 0 0 1 0 13.4"/></svg></span><span class="sli-label">AirPin — связь без интернета</span><span class="sli-value" id="airpinRowValue"></span></button>';
    group.parentNode.insertBefore(wrap, group);
    const foot = document.createElement('div');
    foot.className = 'settings-footnote';
    foot.textContent = native
      ? 'Сообщения передаются через ближайшие телефоны с Asteria (Bluetooth/Wi-Fi), если ни у кого нет интернета. Как только у кого-то из рядом находящихся он появится, он станет мостом для остальных. Включите, пока есть интернет.'
      : 'Если пропала связь, сообщения шифруются, остаются в чате с отметкой 📡 и уходят автоматически, как только интернет вернётся. Связь через соседние телефоны (mesh) доступна в новой версии Android-приложения. Включите, пока есть интернет.';
    group.parentNode.insertBefore(foot, group);
    wrap.querySelector('button').addEventListener('click', () => {
      if (isEnabled()) { if (confirm('Выключить AirPin?')) AP.disable(); } else AP.enable();
    });
    renderRow();
  }

  /* ---------------- старт ---------------- */

  async function init() {
    if (!myId() || AP._ready) return;
    AP._ready = true;
    loadState();
    installRow();
    if (native) {
      try { native.airpinAttach(); } catch (e) { /* ignore */ }
      if (lsGet('enabled', false)) { try { native.airpinStart(myId(), Number(lsGet('since', 0)) || 0); } catch (e) { /* ignore */ } }
    }
    await refreshKeys(false);
    // сообщения, ждавшие в очереди до перезагрузки страницы, возвращаем в чаты
    outbox.filter((x) => x.state === 'queued').forEach((x) => { try { showLocal(x.local); } catch (e) { /* чат ещё не загружен */ } });
    flushViaServer();
    renderRow();
  }

  // состояние приложения появляется после входа — ждём пользователя
  const timer = setInterval(() => {
    if (myId()) { init(); }
    if (AP._ready) {
      clearInterval(timer);
      // реагируем на появление связи с сервером: освежаем ключи и догружаем очередь
      setInterval(() => { if (serverReachable()) { refreshKeys(false); flushViaServer(); } renderRow(); }, 5000);
      window.addEventListener('online', () => setTimeout(() => { refreshKeys(false); flushViaServer(); }, 1500));
    }
  }, 1000);
})();
