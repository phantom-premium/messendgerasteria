/* Asteria — офлайн-режим интерфейса.
 *
 * Что делает:
 *  1) Сохраняет на устройстве (IndexedDB): профиль, список чатов, сообщения каждого чата,
 *     профили собеседников и ИХ ИКОНКИ (аватарки хранятся как файлы, не ссылки).
 *  2) Если сети нет, api() в app.js берёт данные отсюда — приложение открывается и работает как обычно.
 *  3) Показывает под заголовком «Чаты» плашку «Ожидание сети…» и состояние AirPin
 *     (доступен / ищет телефоны рядом / рядом N / мост), чтобы было понятно, что связь без интернета возможна.
 *  4) Когда сеть вернулась — просит app.js досинхронизироваться (resyncAfterReconnect).
 *
 * Скрипт подключается ДО app.js: app.js обращается к window.OfflineStore.
 */
(function () {
  'use strict';

  const DB_NAME = 'asteria-offline';
  const DB_VER = 1;
  const MSGS_KEEP = 150;           // сколько последних сообщений чата хранить
  const AVATAR_MAX_BYTES = 1.5 * 1024 * 1024;
  const AVATAR_MAX_COUNT = 500;

  const S = () => (typeof state !== 'undefined' ? state : null);
  const $id = (id) => document.getElementById(id);
  const isEn = () => document.documentElement.lang === 'en';

  /* ---------------- IndexedDB ---------------- */

  let dbPromise = null;
  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB недоступен')); return; }
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const d = req.result;
        ['kv', 'msgs', 'blobs'].forEach((n) => { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n); });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
  }
  function run(store, mode, fn) {
    return db().then((d) => new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      let req;
      try { req = fn(t.objectStore(store)); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }
  const idbGet = (store, key) => run(store, 'readonly', (s) => s.get(key)).catch(() => undefined);
  const idbSet = (store, key, val) => run(store, 'readwrite', (s) => s.put(val, key)).catch(() => undefined);
  const idbKeys = (store) => run(store, 'readonly', (s) => s.getAllKeys()).catch(() => []);
  const idbDel = (store, key) => run(store, 'readwrite', (s) => s.delete(key)).catch(() => undefined);

  /* ---------------- иконки пользователей ---------------- */

  const objUrlByOrig = new Map();   // '/uploads/a.jpg' -> 'blob:…'
  const origByObjUrl = new Map();   // 'blob:…' -> '/uploads/a.jpg'
  const knownAvatars = new Set();   // что уже лежит в хранилище
  const avatarQueue = [];
  let avatarBusy = 0;

  idbKeys('blobs').then((ks) => ks.forEach((k) => knownAvatars.add(k)));

  function walk(node, fn, depth) {
    if (!node || typeof node !== 'object' || (depth || 0) > 8) return;
    if (Array.isArray(node)) { node.forEach((x) => walk(x, fn, (depth || 0) + 1)); return; }
    Object.keys(node).forEach((k) => {
      const v = node[k];
      fn(node, k, v);
      if (v && typeof v === 'object') walk(v, fn, (depth || 0) + 1);
    });
  }
  const isAvatarUrl = (k, v) => k === 'avatar' && typeof v === 'string' && v.indexOf('/uploads/') === 0;

  function collectAvatars(obj) {
    const out = new Set();
    walk(obj, (o, k, v) => { if (isAvatarUrl(k, v)) out.add(v); });
    return out;
  }

  function prefetchAvatars(urls) {
    urls.forEach((u) => { if (!knownAvatars.has(u) && !avatarQueue.includes(u) && knownAvatars.size < AVATAR_MAX_COUNT) avatarQueue.push(u); });
    pumpAvatars();
  }
  function pumpAvatars() {
    while (avatarBusy < 2 && avatarQueue.length) {
      const u = avatarQueue.shift();
      avatarBusy++;
      fetch(u, { credentials: 'include' })
        .then((r) => (r.ok ? r.blob() : null))
        .then((b) => {
          if (b && b.size <= AVATAR_MAX_BYTES && /^image\//.test(b.type || 'image/')) {
            return idbSet('blobs', u, b).then(() => knownAvatars.add(u));
          }
        })
        .catch(() => { /* нет сети — попробуем при следующем ответе сервера */ })
        .then(() => { avatarBusy--; pumpAvatars(); });
    }
  }

  async function objectUrlFor(u) {
    if (objUrlByOrig.has(u)) return objUrlByOrig.get(u);
    const blob = await idbGet('blobs', u);
    if (!blob) return null;
    const ou = URL.createObjectURL(blob);
    objUrlByOrig.set(u, ou); origByObjUrl.set(ou, u);
    return ou;
  }

  /** Подменяет /uploads/… в поле avatar на локальную копию (если она есть). */
  async function rewriteAvatars(obj) {
    const urls = collectAvatars(obj);
    if (!urls.size) return obj;
    const map = new Map();
    await Promise.all([...urls].map(async (u) => { const ou = await objectUrlFor(u); if (ou) map.set(u, ou); }));
    if (map.size) walk(obj, (o, k, v) => { if (k === 'avatar' && map.has(v)) o[k] = map.get(v); });
    return obj;
  }

  // blob:-адреса нельзя класть в хранилище — возвращаем исходные ссылки
  function cloneForStorage(obj) {
    return JSON.parse(JSON.stringify(obj, (k, v) => (typeof v === 'string' && v.indexOf('blob:') === 0 ? (origByObjUrl.get(v) || v) : v)));
  }

  /* ---------------- кэш ответов api() ---------------- */

  const REMEMBER_RE = /^\/api\/(me|folders|calls|users\/[^/?]+|conversations\/[^/?]+\/members)$/;
  const MSG_RE = /^\/api\/conversations\/([^/?]+)\/messages$/;
  let usedCache = false;

  function mark(obj) {
    Object.defineProperty(obj, '__offline', { value: true, enumerable: false });
    return obj;
  }

  async function remember(path, data) {
    try {
      const p = path.split('?')[0];
      const hasBefore = path.indexOf('before=') !== -1;
      if (p === '/api/conversations') {
        await idbSet('kv', 'conversations', cloneForStorage(data.conversations || []));
        prefetchAvatars(collectAvatars(data));
        return;
      }
      const m = p.match(MSG_RE);
      if (m) {
        if (!hasBefore && Array.isArray(data.messages)) await storeMessages(m[1], data.messages, true);
        return;
      }
      if (REMEMBER_RE.test(p) && path.indexOf('q=') === -1) {
        await idbSet('kv', 'api:' + path, cloneForStorage(data));
        prefetchAvatars(collectAvatars(data));
      }
    } catch (e) { /* кэш — необязательная часть */ }
  }

  async function fromCache(path) {
    try {
      const p = path.split('?')[0];
      const hasBefore = path.indexOf('before=') !== -1;
      let out = null;
      if (p === '/api/conversations') {
        const list = await idbGet('kv', 'conversations');
        if (list) out = { conversations: list };
      } else if (MSG_RE.test(p)) {
        if (hasBefore) return null; // старые страницы без сети не дозагружаем — app.js тихо игнорирует ошибку
        const rec = await idbGet('msgs', p.match(MSG_RE)[1]);
        out = { messages: (rec && rec.list) || [], hasMore: false };
      } else if (p === '/api/stories') {
        out = { stories: [] };
      } else if (p === '/api/banner') {
        out = { banner: null };
      } else {
        const v = await idbGet('kv', 'api:' + path);
        if (v) out = v;
      }
      if (!out) return null;
      await rewriteAvatars(out);
      usedCache = true;
      wasDown = true;
      return mark(out);
    } catch (e) { return null; }
  }

  /* ---------------- сообщения на телефоне ---------------- */

  async function storeMessages(convId, list, replace) {
    let merged = list;
    if (!replace) {
      const rec = await idbGet('msgs', convId);
      const byId = new Map(((rec && rec.list) || []).map((x) => [x.id, x]));
      list.forEach((x) => byId.set(x.id, x));
      merged = [...byId.values()];
    }
    merged = merged.filter((x) => x && !x.pending && !x.pid).sort((a, b) => a.createdAt - b.createdAt).slice(-MSGS_KEEP);
    await idbSet('msgs', convId, { list: cloneForStorage(merged), at: Date.now() });
    const urls = new Set();
    merged.forEach((x) => walk(x, (o, k, v) => { if (isAvatarUrl(k, v)) urls.add(v); }));
    if (urls.size) prefetchAvatars(urls);
  }

  const sigs = {};
  let convSig = '';
  async function snapshot() {
    const st = S();
    if (!st || !st.user) return;
    try {
      if (st.conversationsReady && st.conversations.length) {
        const sig = st.conversations.map((c) => [c.id, c.lastMessageAt || 0, c.unreadCount || 0, c.name || '', c.pinnedMessageId || ''].join(':')).join('|');
        if (sig !== convSig) {
          convSig = sig;
          await idbSet('kv', 'conversations', cloneForStorage(st.conversations));
          prefetchAvatars(collectAvatars(st.conversations));
        }
      }
      const ids = Object.keys(st.messages || {});
      for (const id of ids) {
        const list = st.messages[id];
        if (!list || !list.length) continue;
        const last = list[list.length - 1];
        let rx = 0;
        for (let i = Math.max(0, list.length - 40); i < list.length; i++) {
          const m = list[i];
          rx += (m.reactions ? JSON.stringify(m.reactions).length : 0) + (m.content ? m.content.length : 0) + (m.editedAt || 0) % 1000;
        }
        const sig = list.length + ':' + last.id + ':' + rx;
        if (sigs[id] === sig) continue;
        sigs[id] = sig;
        await storeMessages(id, list, !!(st.messagesLoaded && st.messagesLoaded[id]));
      }
    } catch (e) { /* ignore */ }
  }
  setInterval(snapshot, 5000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') snapshot(); });
  window.addEventListener('pagehide', snapshot);

  async function clear() {
    try {
      const d = await db();
      await new Promise((resolve) => {
        const t = d.transaction(['kv', 'msgs', 'blobs'], 'readwrite');
        ['kv', 'msgs', 'blobs'].forEach((n) => t.objectStore(n).clear());
        t.oncomplete = t.onerror = t.onabort = () => resolve();
      });
    } catch (e) { /* ignore */ }
    knownAvatars.clear();
  }

  /* ---------------- статус сети под заголовком «Чаты» ---------------- */

  const TXT = {
    ru: {
      waiting: 'Ожидание сети', back: 'Сеть появилась ✓',
      off: 'AirPin: связь без интернета', offNoKeys: 'AirPin заработает после входа с интернетом',
      starting: 'AirPin запускается…', search: 'Ищем телефоны рядом…',
      near: (n, bridge) => 'Рядом: ' + n + (bridge ? ' · мост' : ''),
      queue: (q) => 'Сообщения уйдут, когда будет сеть' + (q ? ' · в очереди: ' + q : ''),
      enable: 'Включить', saved: 'Чаты и сообщения сохранены на телефоне',
    },
    en: {
      waiting: 'Waiting for network', back: 'Back online ✓',
      off: 'AirPin: messaging without internet', offNoKeys: 'AirPin will work after you sign in online',
      starting: 'AirPin is starting…', search: 'Looking for nearby phones…',
      near: (n, bridge) => 'Nearby: ' + n + (bridge ? ' · bridge' : ''),
      queue: (q) => 'Messages will send when online' + (q ? ' · queued: ' + q : ''),
      enable: 'Turn on', saved: 'Chats and messages are saved on this phone',
    },
  };
  const tr = () => (isEn() ? TXT.en : TXT.ru);

  let androidOnline = null;
  let wasDown = false;          // были «без сети» — после возвращения надо досинхронизироваться
  let wasWaiting = false;
  let appShownAt = 0;
  let recoverTimer = null;
  let lastKey = '';
  let lastResync = 0;

  try {
    if (window.AsteriaNotify && typeof window.AsteriaNotify.isOnline === 'function') androidOnline = !!window.AsteriaNotify.isOnline();
  } catch (e) { /* старая версия приложения */ }

  // Android сообщает об изменении сети сам (см. MainActivity.onNetChanged)
  window.AsteriaNet = { set(v) { androidOnline = !!v; render(); } };

  const wsOpen = () => { const st = S(); return !!(st && st.ws && st.ws.readyState === 1); };
  const appVisible = () => { const a = $id('appScreen'); return !!a && !a.classList.contains('hidden'); };

  function isWaiting() {
    if (!appVisible()) return false;
    if (!appShownAt) appShownAt = Date.now();
    if (wsOpen()) return false;                       // сервер отвечает — сеть есть
    if (navigator.onLine === false || androidOnline === false) return true;
    return Date.now() - appShownAt > 4000;            // сокет не поднялся за 4 с
  }

  function apInfo() {
    try { return (window.AirPin && window.AirPin.statusInfo && window.AirPin.statusInfo()) || null; } catch (e) { return null; }
  }

  function describe() {
    const t = tr();
    const ap = apInfo();
    if (!ap || !ap.ready) return { mode: 'off', sub: t.off, button: !!ap && ap.hasKeys !== false ? t.enable : '' };
    if (!ap.enabled) return { mode: 'off', sub: ap.hasKeys ? t.off : t.offNoKeys, button: ap.hasKeys ? t.enable : '' };
    if (!ap.native) return { mode: 'queue', sub: t.queue(ap.queued), button: '' };
    if (!ap.running) return { mode: 'search', sub: t.starting, button: '' };
    if (ap.peers > 0) return { mode: 'mesh', sub: t.near(ap.peers, ap.bridge), button: '' };
    return { mode: 'search', sub: t.search, button: '' };
  }

  function relayoutStories() {
    try { if (typeof window.storiesRelayout === 'function') window.storiesRelayout(); } catch (e) { /* не критично */ }
  }

  function render() {
    const el = $id('netStatus');
    if (!el) return;
    const waiting = isWaiting();
    const wasOff = document.body.classList.contains('net-offline');
    document.body.classList.toggle('net-offline', waiting);
    // Плашка появилась/исчезла — лента историй должна перемерить себя (см. storiesRelayout в app.js)
    if (wasOff !== waiting) relayoutStories();

    if (!waiting) {
      if (wasWaiting) {
        // сеть вернулась: короткое «Сеть появилась ✓» и скрываем
        wasWaiting = false;
        el.className = 'net-status show ok';
        $id('nsTitle').textContent = tr().back;
        $id('nsSub').textContent = '';
        $id('nsBtn').classList.add('hidden');
        lastKey = 'ok';
        clearTimeout(recoverTimer);
        recoverTimer = setTimeout(() => { recoverTimer = null; el.className = 'net-status'; lastKey = ''; relayoutStories(); }, 2200);
      } else if (!recoverTimer) {
        el.className = 'net-status';
      }
      return;
    }

    wasWaiting = true; wasDown = true;
    clearTimeout(recoverTimer); recoverTimer = null;
    const d = describe();
    const key = [d.mode, d.sub, d.button, isEn()].join('|');
    if (key === lastKey) return;
    lastKey = key;
    el.className = 'net-status show ' + d.mode;
    $id('nsTitle').innerHTML = tr().waiting + '<span class="ns-dots"></span>';
    $id('nsSub').textContent = d.sub;
    const btn = $id('nsBtn');
    btn.textContent = d.button;
    btn.classList.toggle('hidden', !d.button);
  }

  function bindUi() {
    const btn = $id('nsBtn');
    if (btn && !btn._bound) {
      btn._bound = true;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.AirPin && window.AirPin.enable) window.AirPin.enable().then(render);
      });
    }
    const el = $id('netStatus');
    if (el && !el._bound) {
      el._bound = true;
      el.addEventListener('click', () => {
        if (typeof showToast === 'function') showToast(tr().saved);
      });
    }
  }

  setInterval(() => { bindUi(); render(); }, 1000);
  window.addEventListener('online', render);
  window.addEventListener('offline', render);
  window.addEventListener('airpin-status', render);
  document.addEventListener('DOMContentLoaded', () => { bindUi(); render(); });

  /* ---------------- события WebSocket (зовёт app.js) ---------------- */

  let wsWasOpen = false;
  function onWsOpen() {
    wsWasOpen = true;
    render();
    if (wasDown || usedCache) {
      wasDown = false; usedCache = false;
      const now = Date.now();
      if (now - lastResync > 5000 && typeof window.resyncAfterReconnect === 'function') {
        lastResync = now;
        window.resyncAfterReconnect();
      }
    }
  }
  function onWsClose() {
    if (wsWasOpen) wasDown = true;
    render();
  }

  window.OfflineStore = { fromCache, remember, clear, snapshot, onWsOpen, onWsClose, rewriteAvatars };
})();
