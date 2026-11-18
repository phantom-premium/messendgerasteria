'use strict';

// Фикс для мобильных браузеров: 100vh не учитывает появляющуюся/скрывающуюся
// адресную строку и системную панель навигации, из-за чего интерфейс "уезжает"
// под них. Считаем реальную высоту через innerHeight (и visualViewport, если
// доступен — он точнее всего отражает видимую область с учётом клавиатуры).
function setRealViewportHeight() {
  const h = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  document.documentElement.style.setProperty('--vh', (h * 0.01) + 'px');
}
setRealViewportHeight();
// В PWA, запущенном с "Домой" на iOS, на самом первом рендере innerHeight/
// visualViewport.height иногда ещё не равны настоящей высоте экрана (система
// досчитывает границы окна уже ПОСЛЕ первой отрисовки), а событие resize
// потом не срабатывает — его нечему вызвать, ведь адресной строки, которая
// обычно скрывается/появляется и триггерит resize, в standalone-режиме нет.
// Из-за этого --vh замораживался на заниженном значении, и .app-screen
// оказывался короче реального экрана. Теперь высота в CSS в первую очередь
// берётся из нативного 100dvh (см. style.css) — это исправление на будущее,
// не зависящее от таймингов. Но на случай очень старых iOS без поддержки
// dvh переcчитываем --vh ещё несколько раз в первые секунды после запуска,
// чтобы --vh тоже не остался "замороженным" на неверном значении.
[0, 100, 300, 600, 1200].forEach((delay) => setTimeout(setRealViewportHeight, delay));

// ---------- Диагностика вьюпорта — удалена ----------
// Использовалась только для отладки бага с нижней панелью на iOS PWA;
// баг диагностирован (ограничение платформы), диагностику убрали.
window.addEventListener('resize', () => { setRealViewportHeight(); });
window.addEventListener('orientationchange', () => setTimeout(() => { setRealViewportHeight(); }, 250));
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => { setRealViewportHeight(); });
}

// ---------- Проверка свежести клиента (важно для iOS "домашнего экрана") ----------
// На iOS приложение, добавленное на экран "Домой", при повторном открытии
// часто не перезагружает страницу, а "размораживает" старую вкладку прямо
// из памяти — даже если сервер тем временем обновился. Тогда старый JS
// начинает работать с новым бэкендом (новые поля в ответах, новые события
// по сокету) и интерфейс начинает вести себя странно или разваливаться.
// Сверяем метку сборки сервера при каждом возврате приложения на передний
// план и, если она изменилась с прошлого раза — значит, эта вкладка
// пережила деплой, и её нужно перезагрузить с нуля.
//
// Также при каждом таком возврате (pageshow / visibilitychange) заново
// пересчитываем --vh: если сайт уже был открыт как обычная вкладка Safari,
// а затем запущен через иконку "Домой", iOS иногда "восстанавливает" уже
// существующую вкладку из памяти вместо чистого запуска — со старыми
// размерами viewport, посчитанными под интерфейс Safari.
window.addEventListener('pageshow', (e) => { setRealViewportHeight(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { setRealViewportHeight(); } });

(function watchBuildFreshness() {
  const STORAGE_KEY = 'asteria_build_id';
  function check() {
    fetch('/api/web/build', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        const current = data && data.build;
        if (!current) return;
        const stored = sessionStorage.getItem(STORAGE_KEY);
        if (!stored) {
          sessionStorage.setItem(STORAGE_KEY, current);
        } else if (stored !== current) {
          // ВАЖНО: обновляем сохранённое значение ДО reload(). sessionStorage
          // переживает перезагрузку страницы (в отличие от закрытия вкладки),
          // поэтому если не обновить его здесь, после reload() эта же
          // проверка снова увидит несовпадение с тем же старым stored — и
          // уйдёт в бесконечный цикл перезагрузок (ровно тот баг, который
          // ловили: "загрузился, тут же снова загружается, и так без конца").
          sessionStorage.setItem(STORAGE_KEY, current);
          location.reload();
        }
      })
      .catch(() => {}); // офлайн/сеть недоступна — не мешаем работать дальше
  }
  check();
  // pageshow с persisted:true — сигнал именно о "восстановлении" страницы
  // из памяти/bfcache, а не о новой загрузке (самый частый случай на iOS
  // при возврате в home-screen приложение).
  window.addEventListener('pageshow', (e) => { if (e.persisted) check(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
})();

// ---------- Тема оформления ----------
// state.user.theme (когда пользователь авторизован) — источник истины,
// привязан к аккаунту и приходит с сервера при каждом открытии вкладки
// (см. onAuthed). localStorage используется только как кэш для мгновенной
// отрисовки правильной темы ДО того, как придёт ответ /api/me — чтобы не
// было вспышки не той темы при открытии новой вкладки.
const THEME_STORAGE_KEY = 'asteria_theme_pref';
let currentThemePref = 'light';

// ---------- Энергосбережение ----------
// Чисто клиентская настройка (не привязана к аккаунту, как тема) — хранится
// в localStorage, читается один раз при загрузке и восстанавливается в
// чекбокс на подстранице "Энергосбережение" (сама подстраница до открытия
// скрыта классом .hidden, но элемент #powerSavingCheckbox уже есть в DOM,
// так что применить сохранённое значение можно сразу).
const POWER_SAVING_STORAGE_KEY = 'asteria_power_saving';

function resolveTheme(pref) {
  if (!pref || pref === 'system') {
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  return pref;
}

function applyThemePref(pref) {
  currentThemePref = pref || 'light';
  document.documentElement.dataset.theme = resolveTheme(currentThemePref);
  try { localStorage.setItem(THEME_STORAGE_KEY, currentThemePref); } catch (e) {}
  if (typeof highlightActiveThemeSwatch === 'function') highlightActiveThemeSwatch();
  updateNativeSystemBars();
}

// ---------- Верх/низ экрана в Android-приложении под цвет темы ----------
// Раньше статус-бар и панель навигации Android были зашиты в нативном коде
// одним фиксированным цветом — при светлой теме внутри чата низ экрана
// (панель навигации) оставался чёрным. Читаем РЕАЛЬНЫЙ отрисованный цвет
// конкретных панелей экрана (а не просто переменную темы --bg) — при
// открытом чате это шапка с именем собеседника (.chat-header) сверху и
// поле ввода (.composer) снизу, иначе — общий фон текущего раздела. Это
// надёжнее, чем полагаться на то, что переменная темы всегда совпадает с
// реальным цветом этих панелей (в этом самом проекте они уже не раз
// расходились и сходились обратно в ходе правок).
function resolveCssColorToRgb(cssColor) {
  const probe = document.createElement('div');
  probe.style.color = cssColor;
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color; // всегда придёт как "rgb(r, g, b)"
  document.body.removeChild(probe);
  const m = computed.match(/\d+/g);
  return m ? m.slice(0, 3).map(Number) : [255, 255, 255];
}
function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}
function isDarkColor([r, g, b]) {
  // Относительная яркость по стандартной формуле — темнее половины значит
  // фон тёмный, значит значкам статус-бара/навигации нужно быть светлыми,
  // чтобы не потеряться на нём (и наоборот).
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}
// Достаёт РЕАЛЬНЫЙ фон элемента, а не то, что написано в CSS-правиле —
// если фон прозрачный/не задан явно, поднимается вверх по родителям, пока
// не найдёт непрозрачный (иначе получим rgba(0,0,0,0), бесполезный сам по
// себе для решения "какой цвет красить снаружи страницы").
function resolveEffectiveBackground(el) {
  let node = el;
  while (node && node !== document.documentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    const m = bg.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    if (m && (m[4] === undefined || parseFloat(m[4]) > 0.5)) return [Number(m[1]), Number(m[2]), Number(m[3])];
    node = node.parentElement;
  }
  return resolveCssColorToRgb(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#ffffff');
}
function updateNativeSystemBars() {
  if (!window.AsteriaNotify || typeof window.AsteriaNotify.setSystemBarColors !== 'function') return; // не Android-приложение — не при чём
  try {
    const chatOpen = $('#appScreen') && $('#appScreen').classList.contains('chat-open');
    const chatHeaderEl = chatOpen ? $('.chat-header') : null;
    const composerEl = chatOpen ? $('.composer') : null;
    const topRgb = chatHeaderEl ? resolveEffectiveBackground(chatHeaderEl) : resolveCssColorToRgb(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#ffffff');
    const bottomRgb = composerEl ? resolveEffectiveBackground(composerEl) : resolveCssColorToRgb(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#ffffff');
    window.AsteriaNotify.setSystemBarColors(rgbToHex(topRgb), rgbToHex(bottomRgb), isDarkColor(topRgb), isDarkColor(bottomRgb));
  } catch (e) { /* не критично — просто останутся цвета по умолчанию из themes.xml */ }
}

// применяем как можно раньше — до логина, до ответа сервера
try { applyThemePref(localStorage.getItem(THEME_STORAGE_KEY) || 'light'); } catch (e) { applyThemePref('light'); }

// если выбран режим «как в системе» — переключаемся вживую при смене темы ОС
if (window.matchMedia) {
  const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const onSystemThemeChange = () => { if (currentThemePref === 'system') applyThemePref('system'); };
  if (systemThemeQuery.addEventListener) systemThemeQuery.addEventListener('change', onSystemThemeChange);
  else if (systemThemeQuery.addListener) systemThemeQuery.addListener(onSystemThemeChange);
}

const state = {
  user: null,
  conversations: [],
  folders: [],
  activeFolderId: null,
  activeSection: 'chats',
  activeConvId: null,
  messages: {}, // convId -> [messages]
  // БАГ: раньше "загружена ли история чата" определялось прямой проверкой
  // !state.messages[convId] — а её же попутно создавал (пустым массивом) и
  // WS-обработчик входящих сообщений (handleWSEvent, msg.type==='message'),
  // чтобы было куда положить только что пришедшее сообщение для чата,
  // который в этой сессии ЕЩЁ НИ РАЗУ не открывали. В итоге, если в такой
  // непросмотренный чат прилетало сообщение, state.messages[convId]
  // становился "непустым" (в нём лежало ровно это одно сообщение) — и когда
  // человек затем впервые открывал этот чат, openConversation видел
  // непустой state.messages[convId] и решал, что история уже загружена,
  // пропуская реальный запрос за историей. Показывалось только то самое
  // прилетевшее сообщение, вся переписка до него — нет, вплоть до
  // перезапуска приложения (когда state.messages создаётся заново с нуля).
  // Отдельный флаг ниже отражает именно факт "история запрошена и
  // получена", а не просто "в массиве что-то есть".
  messagesLoaded: {}, // convId -> история сообщений реально запрошена с сервера
  messagesHasMore: {}, // convId -> есть ли ещё более старые сообщения на сервере
  messagesLoadingOlder: false, // идёт ли сейчас подгрузка старых сообщений (защита от дублей)
  replyingTo: null, // сообщение, на которое сейчас отвечаем в активном чате
  usersById: {},
  ws: null,
  peerConn: null,
  localStream: null,
  currentCallPeerId: null,
  circleRecorder: null,
  circleChunks: [],
  circleStream: null,
  circleMime: '',
  circleTranscriber: null, // текущее распознавание речи (см. startLiveTranscription), пока идёт запись кружка
  voiceRecorder: null,
  voiceChunks: [],
  voiceMime: '',
  voiceTranscriber: null, // текущее распознавание речи, пока идёт запись голосового
  voiceStream: null,
  voiceStartedAt: 0,
  voiceTimerInt: null,
  typingTimeout: null,
  pendingImageFile: null,
  mediaBatchFiles: [], // [{file, kind}] — очередь для отправки нескольких фото/видео за раз (см. openMediaBatch)
  forwardMessage: null, // сообщение, которое сейчас пересылаем (см. openForwardPicker)
  forwardSelectedConvIds: new Set(), // выбранные получатели в модалке пересылки
  shareDraft: null, // содержимое, присланное из другого приложения через «Поделиться» (Android)
  micOn: true,
  camOn: true,
  hasCamera: false,
  currentFacingMode: 'user',
  remoteCamOn: false,
  callStartedAt: 0,
  callTimerInt: null,
  callMediaWatchdogInt: null,
  callMediaStuck: false,
};

const STICKERS = ['😀','😂','😍','😎','🥳','😢','😡','👍','👎','🔥','🎉','❤️','💯','🙏','👀','🤔','😴','🤩','😱','👏','🚀','✨','🌟','🍕','☕','🐱','🐶','⚡','🌈','🎵'];
const REACTIONS = ['👍','👎','❤️','😂','😮','😢','🔥','👌','😡','🤩','🥳','💯','⚡','🌟','😍'];

// Готовые фоны чата.
const FREE_WALLPAPERS = [
  { id: 'tattoo', label: 'Графика', css: "url('/wallpapers/free-tattoo.webp')" },
  { id: 'doodle-blue', label: 'Смайлы', css: "url('/wallpapers/free-doodle-blue.jpeg')" },
  { id: 'space', label: 'Космос', css: "url('/wallpapers/free-space.jpeg')" },
  { id: 'pets-pink', label: 'Цветы', css: "url('/wallpapers/free-pets-pink.jpeg')" },
];

function $(sel) { return document.querySelector(sel); }
function showModal(sel) { const el = typeof sel === 'string' ? $(sel) : sel; if (el) { document.body.appendChild(el); el.classList.remove('hidden'); } return el; }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

async function api(path, opts = {}) {
  const method = opts.method || 'GET';
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (netErr) {
    // Нет сети: для чтения отдаём то, что сохранено на телефоне (см. offline.js) —
    // так приложение открывается и показывает чаты, сообщения и иконки без интернета.
    if (method === 'GET' && window.OfflineStore) {
      const cached = await window.OfflineStore.fromCache(path);
      if (cached) return cached;
    }
    throw netErr;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка запроса');
  if (method === 'GET' && window.OfflineStore) window.OfflineStore.remember(path, data);
  return data;
}

// БАГ: ссылки на профиль/приглашения и QR-коды строились из location.origin
// — того адреса, по которому браузер ПРЯМО СЕЙЧАС открыл страницу. Если
// сервер настроен на нормальный домен (PUBLIC_HOST, см. README — именно на
// него выписан HTTPS-сертификат), а конкретный человек в моменте зашёл по
// голому IP, ссылка получалась с тем же голым IP вместо официального
// адреса. Запрашиваем канонический публичный адрес у сервера один раз при
// загрузке (без авторизации, не блокируя старт приложения) и используем
// его везде, где раньше был location.origin для внешних ссылок/QR —
// с падением обратно на location.origin, если домен не настроен.
let cachedPublicOrigin = null;
const publicOriginReady = fetch('/api/public-config').then((r) => r.json()).then((d) => {
  cachedPublicOrigin = (d && d.publicOrigin) || null;
}).catch(() => {});
function publicOrigin() { return cachedPublicOrigin || location.origin; }

function initials(name) {
  return (name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

function preloadAvatarAndRepaint(el, url) {
  if (!el || !url) return;
  const img = new Image();
  img.onload = () => {
    el.style.display = 'none';
    void el.offsetHeight;
    el.style.display = '';
  };
  img.src = url;
}

function avatarStyle(user) {
  if (user && user.avatar) return `background-image:url('${user.avatar}')`;
  return '';
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

// Подпись времени последнего сообщения в списке чатов, в духе Telegram:
// сегодняшние сообщения — просто время (ЧЧ:ММ), сообщения за последние
// ~6 дней — сокращённый день недели ("пн", "вт"...), более старые — дата
// в компактном виде дд.мм.гг. Год добавляем отдельным условием только для
// сообщений старше 3 лет вместе с датой, чтобы не загромождать список чатов.
function convListTimeLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (diffDays <= 0) return fmtTime(ts);
  if (diffDays < 7) return d.toLocaleDateString('ru-RU', { weekday: 'short' }).replace('.', '');
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

// Числовой ключ календарного дня (год*10000 + месяц*100 + день) — по нему
// сравниваем, поменялись ли сутки между соседними сообщениями, не думая
// о часовых поясах/времени внутри дня.
function dayKeyOf(ts) {
  const d = new Date(ts);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

// Подпись плашки-разделителя дня в ленте сообщений: "Сегодня"/"Вчера" для
// последних суток, "17 июня" для остальных дней текущего года, "17 июня
// 2024" для прошлых лет, а если сообщение совсем старое (от 3 лет и
// старше) — просто год, без лишних подробностей.
function dateSeparatorLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (diffDays === 0) return 'Сегодня';
  if (diffDays === 1) return 'Вчера';
  const yearsDiff = now.getFullYear() - d.getFullYear();
  if (yearsDiff >= 3) return String(d.getFullYear());
  return d.toLocaleDateString('ru-RU', yearsDiff === 0 ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' });
}

// Сама плашка-разделитель ("Вчера"/"Сегодня"/дата), которую вставляем
// перед первым сообщением каждого нового календарного дня.
function renderDateSeparator(ts) {
  const row = document.createElement('div');
  row.className = 'date-separator';
  row.dataset.dayKey = String(dayKeyOf(ts));
  row.innerHTML = `<span class="date-separator-pill">${escapeHtml(dateSeparatorLabel(ts))}</span>`;
  return row;
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Простое безопасное форматирование текста сообщений: **жирный**, *курсив*,
// ~~зачёркнутый~~, `код`, [текст](ссылка) и голые http/https-ссылки.
// ВАЖНО: сначала полностью экранируем HTML (защита от XSS), и только потом
// разбираем markdown-разметку по уже экранированной строке — сами символы
// разметки (* _ ~ ` [ ] ( )) экранированием не затрагиваются.
// Тот же разбор разметки, что и в formatMessageText, но на выходе — ОБЫЧНЫЙ
// текст без маркеров (**жирный**, *курсив*, __, ~~, `код`, [текст](ссылка)).
// Нужен там, где HTML нельзя/не нужно показывать: превью в списке чатов, в
// ответе на сообщение, в закреплённом, в уведомлениях. БАГ: там выводился
// сырой текст, и форматированное сообщение светилось со звёздочками.
function stripMessageFormatting(raw) {
  let s = String(raw == null ? '' : raw);
  s = s.replace(/\[([^\[\]\n]{1,300})\]\((https?:\/\/[^\s()<>]{1,600})\)/g, '$1');
  s = s.replace(/`([^`\n]+)`/g, '$1');
  s = s.replace(/\*\*([^\n]+?)\*\*/g, '$1');
  s = s.replace(/__([^\n]+?)__/g, '$1');
  s = s.replace(/~~([^\n]+?)~~/g, '$1');
  s = s.replace(/\*([^*\n]+?)\*/g, '$1');
  s = s.replace(/(^|\s)_([^_\n]+?)_(?=$|\s|[.,!?:;])/g, '$1$2');
  return s;
}

function formatMessageText(raw) {
  let s = escapeHtml(raw);
  const stash = [];
  const put = (html) => { stash.push(html); return `\u0000${stash.length - 1}\u0000`; };

  // Ссылки прячем за плейсхолдеры ДО разбора *_~ — иначе символы в самом
  // тексте ссылки или её описании могли бы случайно схлопнуться в разметку.
  s = s.replace(/\[([^\[\]\n]{1,300})\]\((https?:\/\/[^\s()<>]{1,600})\)/g, (_, text, url) =>
    put(`<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${text}</a>`));
  s = s.replace(/(https?:\/\/[^\s<>"']{4,600})/g, (url) =>
    put(`<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`));

  s = s.replace(/`([^`\n]+)`/g, (_, code) => put(`<code>${code}</code>`));
  s = s.replace(/\*\*([^\n]+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/__([^\n]+?)__/g, '<b>$1</b>');
  s = s.replace(/~~([^\n]+?)~~/g, '<s>$1</s>');
  s = s.replace(/\*([^*\n]+?)\*/g, '<i>$1</i>');
  s = s.replace(/(^|\s)_([^_\n]+?)_(?=$|\s|[.,!?:;])/g, '$1<i>$2</i>');

  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
  return s;
}

// Синяя галочка у верифицированных админом пользователей — рисуется рядом с
// именем везде, где имя выводится через innerHTML (шапка чата, сообщения,
// профиль, поиск людей, админ-панель и т.д.). Значок — инлайновый SVG:
// сплошной синий круг + белая галочка со скруглёнными концами/сгибом.
// Метка «A+» — канал/чат есть в перечне Дарккомнадзора (выдаёт администратор, conv.isRegistered).
function rknBadge(conv) {
  if (!conv || !conv.isRegistered) return '';
  return '<span class="rkn-badge" title="Зарегистрированный канал — есть в перечне Дарккомнадзора">A+</span>';
}
function showRknSheet(conv) {
  const old = document.getElementById('rknSheet');
  if (old) old.remove();
  const isGroup = conv && conv.type === 'group';
  const wrap = document.createElement('div');
  wrap.id = 'rknSheet';
  wrap.className = 'rkn-sheet-overlay';
  wrap.innerHTML = `<div class="rkn-sheet" role="dialog" aria-modal="true">
    <div class="rkn-sheet-handle"></div>
    <div class="rkn-sheet-icon"><span class="rkn-glyph">A<span class="rkn-plus">+</span></span></div>
    <div class="rkn-sheet-title">${isGroup ? 'Это зарегистрированный чат' : 'Это зарегистрированный канал'}</div>
    <div class="rkn-sheet-sub">Он есть в перечне Дарккомнадзора</div>
    <button type="button" class="rkn-sheet-ok">Понятно</button>
  </div>`;
  const close = () => { wrap.classList.remove('open'); setTimeout(() => wrap.remove(), 220); };
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  wrap.querySelector('.rkn-sheet-ok').addEventListener('click', close);
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
}
document.addEventListener('click', (e) => {
  const row = e.target.closest && e.target.closest('[data-rkn-info]');
  if (row) showRknSheet({ type: row.getAttribute('data-rkn-info') });
});

function verifiedBadge(u) {
  if (!u || !u.isVerified) return '';
  return '<span class="verified-badge" title="Аккаунт подтверждён администратором">'
    + '<svg viewBox="0 0 100 100" width="14" height="14" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
    + '<circle cx="50" cy="50" r="48" fill="#1f9be0"/>'
    + '<path d="M 29 50 L 43 64 L 75 32" fill="none" stroke="#fff" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg></span>';
}

// Кольцо вокруг аватара отключено по решению
// продукта.
// рядом с именем. Функция оставлена (используется по всему коду), но теперь
// всегда возвращает пустую строку, чтобы нигде не навешивался класс кольца.
function avatarRingClass(u) {
  return '';
}

function isMobile() { return window.matchMedia('(max-width: 860px)').matches; }

// Универсальный helper: различает обычное нажатие (onTap) и удержание (onLongPress).
// Работает и с мышью, и с тачем через Pointer Events.
function attachLongPress(el, onLongPress, onTap, duration = 480) {
  let timer = null, longFired = false, moved = false, sx = 0, sy = 0;
  const clear = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    longFired = false; moved = false;
    sx = e.clientX; sy = e.clientY;
    clear();
    timer = setTimeout(() => { longFired = true; onLongPress(e); }, duration);
  });
  el.addEventListener('pointermove', (e) => {
    if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) { moved = true; clear(); }
  });
  el.addEventListener('pointerup', () => { clear(); if (!longFired && !moved) onTap(); });
  // pointerleave актуален для мыши (курсор физически ушёл с элемента) — на
  // тачскрине палец никуда не "уходит", пока лежит на месте, но некоторые
  // браузеры всё равно шлют это событие во время удержания (из-за смещения
  // границ/перерисовки под пальцем), из-за чего таймер удержания обрывался
  // и контекстное меню переставало открываться вовсе. Для touch/pen это
  // событие игнорируем — там обрыв удержания и так обрабатывается через
  // pointermove (сдвиг пальца) и pointercancel (жест перехвачен системой).
  el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') clear(); });
  el.addEventListener('pointercancel', clear);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  // если было удержание — гасим последующий click, чтобы не сработали вложенные обработчики (например, лайтбокс)
  el.addEventListener('click', (e) => { if (longFired) { e.preventDefault(); e.stopPropagation(); } }, true);
}

async function getMedia(constraints, opts = {}) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (!opts.silent) alert('Браузер не поддерживает доступ к камере/микрофону, либо сайт открыт не по HTTPS/localhost.');
    throw new Error('getUserMedia unsupported');
  }
  try {
    // Само обращение к getUserMedia — это то, что показывает нативный запрос
    // браузера «Сайт хочет использовать вашу камеру/микрофон». Просто вызываем
    // его с нужными constraints и ждём решения пользователя.
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    if (opts.silent) throw err;
    let msg = 'Не удалось получить доступ к камере/микрофону.';
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      msg = 'Доступ запрещён. Разрешите доступ к камере/микрофону для этого сайта в настройках браузера (значок 🔒/ⓘ рядом с адресом) и попробуйте снова.';
    } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      msg = 'Камера или микрофон не найдены на этом устройстве.';
    } else if (err.name === 'NotReadableError') {
      msg = 'Камера или микрофон уже используются другим приложением.';
    } else if (err.name === 'SecurityError') {
      msg = 'Браузер блокирует доступ к камере/микрофону вне HTTPS. Откройте сайт по localhost или включите флаг для локального IP (см. README).';
    }
    alert(msg);
    throw err;
  }
}

/* ---------------- AUTH ----------------
   Полноэкранный (не модальный) экран входа/регистрации из 6 шагов:
   1. Старт (QR-вход + ссылки «Войти» / «Зарегистрироваться»)
   2. Вход — логин       4. Регистрация — логин
   3. Вход — пароль      5. Регистрация — пароль   6. Регистрация — имя и описание
   Все шаги — это .auth-step внутри #authScreen, переключаются через
   showAuthStep(). Данные каждого шага накапливаются в authState, пока не
   дойдём до финального запроса на сервер (/api/login или /api/register). */

const authState = { loginUsername: '', regUsername: '', regPassword: '' };

const AUTH_STEP_IDS = ['start', 'login1', 'login2', 'logincode', 'reg1', 'reg2', 'reg3'];
function showAuthStep(step) {
  AUTH_STEP_IDS.forEach((s) => {
    const el = $(`.auth-step[data-step="${s}"]`);
    if (el) el.classList.toggle('hidden', s !== step);
  });
  if (step === 'start') {
    startQrLoginFlow();
  } else {
    stopQrLoginFlow();
  }
  if (step !== 'logincode') stopCodeLogin();
  // Автофокус на поле ввода текущего шага — удобнее сразу печатать.
  const focusMap = { login1: '#loginUsername', login2: '#loginPassword', reg1: '#regUsername', reg2: '#regPassword', reg3: '#regDisplayName' };
  if (focusMap[step]) setTimeout(() => { const el = $(focusMap[step]); if (el) el.focus(); }, 50);
}

// Экран 1 → Экран 2 / Экран 4
$('#authGoLogin').addEventListener('click', () => {
  $('#loginStep1Error').textContent = '';
  $('#loginUsername').value = '';
  showAuthStep('login1');
});
$('#authGoRegister').addEventListener('click', async () => {
  // Регистрацию админ может закрыть в админ-панели — спрашиваем сервер до
  // того, как человек начнёт вводить данные.
  try {
    const { open } = await api('/api/registration-status');
    if (open === false) {
      $('#authStartQrError').textContent = 'Регистрация закрыта администратором';
      return;
    }
  } catch (e) { /* не получилось спросить — пусть сервер решит на финальном шаге */ }
  $('#authStartQrError').textContent = '';
  $('#regStep1Error').textContent = '';
  $('#regUsername').value = '';
  showAuthStep('reg1');
});

// Кнопки «назад»
$('#authLoginStep1Back').addEventListener('click', () => showAuthStep('start'));
$('#authLoginStep2Back').addEventListener('click', () => showAuthStep('login1'));
$('#authRegStep1Back').addEventListener('click', () => showAuthStep('start'));
$('#authRegStep2Back').addEventListener('click', () => showAuthStep('reg1'));
$('#authRegStep3Back').addEventListener('click', () => showAuthStep('reg2'));

// Экран 2 (вход, шаг 1 — логин): проверяем, существует ли пользователь.
async function submitLoginStep1() {
  const errEl = $('#loginStep1Error');
  errEl.textContent = '';
  const username = $('#loginUsername').value.trim();
  if (!username) { errEl.textContent = t('auth_err_enter_username'); return; }
  try {
    const { exists } = await api('/api/check-username', { method: 'POST', body: { username } });
    if (!exists) { errEl.textContent = t('auth_err_user_not_found'); return; }
    authState.loginUsername = username;
    $('#loginStep2Error').textContent = '';
    $('#loginPassword').value = '';
    showAuthStep('login2');
  } catch (err) { errEl.textContent = err.message; }
}
$('#loginStep1Next').addEventListener('click', submitLoginStep1);
$('#loginUsername').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLoginStep1(); });

// Экран 3 (вход, шаг 2 — пароль): авторизация.
async function submitLoginStep2() {
  const errEl = $('#loginStep2Error');
  errEl.textContent = '';
  try {
    const { user } = await api('/api/login', {
      method: 'POST',
      body: { username: authState.loginUsername, password: $('#loginPassword').value },
    });
    onAuthed(user);
    await handleDeepLinkIfPresent();
  } catch (err) { errEl.textContent = err.message; }
}
$('#loginStep2Next').addEventListener('click', submitLoginStep2);
$('#loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLoginStep2(); });

// ---- Вход по коду через бота «Коды Asteria» (без пароля) ----
// Новое устройство получает 6-значный код и опрашивает сервер; пользователь отправляет код боту
// на устройстве, где уже вошёл, и отвечает ему «да» — после этого опрос возвращает сессию.
// Вернуться к входу по паролю можно кнопкой на этом же экране.
let codeLoginTicketId = null;
let codeLoginTimer = null;

function stopCodeLogin() {
  if (codeLoginTimer) { clearTimeout(codeLoginTimer); codeLoginTimer = null; }
  codeLoginTicketId = null;
}

async function startCodeLogin(username) {
  stopCodeLogin();
  authState.loginUsername = username;
  $('#loginCodeValue').textContent = '··· ···';
  $('#loginCodeUser').textContent = '@' + username;
  $('#loginCodeStatus').textContent = 'Получаем код…';
  $('#loginCodeError').textContent = '';
  $('#loginCodeRefresh').classList.add('hidden');
  showAuthStep('logincode');
  try {
    const data = await api('/api/code-login/create', { method: 'POST', body: { username } });
    codeLoginTicketId = data.id;
    $('#loginCodeValue').textContent = data.code;
    $('#loginCodeBotName').textContent = data.botName || 'Коды Asteria';
    $('#loginCodeBotUser').textContent = data.bot || 'codes';
    $('#loginCodeStatus').textContent = 'Ждём подтверждения…';
    pollCodeLogin(data.id, data.expiresAt);
  } catch (e) {
    $('#loginCodeStatus').textContent = '';
    $('#loginCodeError').textContent = e.message || 'Не удалось получить код';
    $('#loginCodeRefresh').classList.remove('hidden');
  }
}

function pollCodeLogin(id, expiresAt) {
  const expire = (msg) => {
    stopCodeLogin();
    $('#loginCodeValue').textContent = '··· ···';
    $('#loginCodeStatus').textContent = '';
    $('#loginCodeError').textContent = msg;
    $('#loginCodeRefresh').classList.remove('hidden');
  };
  const tick = async () => {
    if (codeLoginTicketId !== id) return;
    if (Date.now() > expiresAt + 120000) { expire('Код устарел. Получите новый.'); return; }
    try {
      const data = await api(`/api/code-login/${encodeURIComponent(id)}/poll`);
      if (codeLoginTicketId !== id) return;
      if (data.status === 'confirmed' && data.user) {
        stopCodeLogin();
        onAuthed(data.user);
        await handleDeepLinkIfPresent();
        return;
      }
      if (data.status === 'awaiting') $('#loginCodeStatus').textContent = 'Код принят — подтвердите вход в чате с ботом («да»).';
      if (data.status === 'denied') { expire('Вход отклонён на другом устройстве.'); return; }
      if (data.status === 'expired') { expire('Код устарел. Получите новый.'); return; }
    } catch (e) { /* сеть моргнула — следующий тик */ }
    codeLoginTimer = setTimeout(tick, 2000);
  };
  codeLoginTimer = setTimeout(tick, 2000);
}

// С экрана логина: сначала убеждаемся, что такой пользователь есть.
$('#loginStep1Code').addEventListener('click', async () => {
  const errEl = $('#loginStep1Error');
  errEl.textContent = '';
  const username = $('#loginUsername').value.trim();
  if (!username) { errEl.textContent = t('auth_err_enter_username'); return; }
  try {
    const { exists } = await api('/api/check-username', { method: 'POST', body: { username } });
    if (!exists) { errEl.textContent = t('auth_err_user_not_found'); return; }
    startCodeLogin(username);
  } catch (err) { errEl.textContent = err.message; }
});
$('#loginStep2Code').addEventListener('click', () => startCodeLogin(authState.loginUsername));
$('#loginCodeRefresh').addEventListener('click', () => startCodeLogin(authState.loginUsername));
// Обратно к привычному входу с паролем.
$('#loginCodeUsePassword').addEventListener('click', () => {
  $('#loginStep2Error').textContent = '';
  $('#loginPassword').value = '';
  showAuthStep('login2');
});
$('#authLoginCodeBack').addEventListener('click', () => showAuthStep('login1'));

// Экран 4 (регистрация, шаг 1 — логин): проверяем, свободен ли логин.
async function submitRegStep1() {
  const errEl = $('#regStep1Error');
  errEl.textContent = '';
  const username = $('#regUsername').value.trim();
  if (!username) { errEl.textContent = t('auth_err_enter_username'); return; }
  try {
    const { exists } = await api('/api/check-username', { method: 'POST', body: { username } });
    if (exists) { errEl.textContent = t('auth_err_username_taken'); return; }
    authState.regUsername = username;
    $('#regStep2Error').textContent = '';
    $('#regPassword').value = '';
    showAuthStep('reg2');
  } catch (err) { errEl.textContent = err.message; }
}
$('#regStep1Next').addEventListener('click', submitRegStep1);
$('#regUsername').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitRegStep1(); });

// Экран 5 (регистрация, шаг 2 — пароль): базовая валидация длины.
function submitRegStep2() {
  const errEl = $('#regStep2Error');
  errEl.textContent = '';
  const password = $('#regPassword').value;
  if (!password || password.length < 4) { errEl.textContent = t('auth_err_password_short'); return; }
  authState.regPassword = password;
  $('#regStep3Error').textContent = '';
  $('#regNameError').textContent = '';
  $('#regDisplayName').value = '';
  $('#regBio').value = '';
  showAuthStep('reg3');
}
$('#regStep2Next').addEventListener('click', submitRegStep2);
$('#regPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitRegStep2(); });

// Экран 6 (регистрация, шаг 3 — имя и описание): финальная отправка.
async function submitRegStep3() {
  const nameErrEl = $('#regNameError');
  const stepErrEl = $('#regStep3Error');
  nameErrEl.textContent = '';
  stepErrEl.textContent = '';
  const displayName = $('#regDisplayName').value.trim();
  if (!displayName) { nameErrEl.textContent = t('auth_err_enter_name'); return; }
  try {
    const { user } = await api('/api/register', {
      method: 'POST',
      body: {
        username: authState.regUsername,
        password: authState.regPassword,
        displayName,
        description: $('#regBio').value.trim(),
      },
    });
    onAuthed(user);
    await handleDeepLinkIfPresent();
  } catch (err) { stepErrEl.textContent = err.message; }
}
$('#regStep3Submit').addEventListener('click', submitRegStep3);

/* ---------------- ВХОД ПО QR-КОДУ (экран 1 авторизации) ---------------- */

let qrLoginPollTimer = null;
let qrLoginTicketId = null;

async function startQrLoginFlow() {
  stopQrLoginFlow();
  $('#authStartQrError').textContent = '';
  $('#authStartQrWrap').innerHTML = '<div class="chat-header-sub">Загрузка кода…</div>';
  $('#authStartQrCodeText').textContent = '';
  try {
    const { id, expiresAt } = await api('/api/qr-login/create', { method: 'POST' });
    qrLoginTicketId = id;
    await publicOriginReady;
    const link = `${publicOrigin()}/qr/${id}`;
    renderQrInto($('#authStartQrWrap'), link);
    $('#authStartQrCodeText').textContent = id;
    pollQrLoginTicket(id, expiresAt);
  } catch (e) {
    $('#authStartQrWrap').innerHTML = '';
    $('#authStartQrError').textContent = e.message || 'Не удалось создать код, попробуйте ещё раз';
  }
}

function stopQrLoginFlow() {
  if (qrLoginPollTimer) { clearTimeout(qrLoginPollTimer); qrLoginPollTimer = null; }
  qrLoginTicketId = null;
}

function pollQrLoginTicket(id, expiresAt) {
  const tick = async () => {
    // Экран уже закрыт (ушли на другой шаг) или это опрос от предыдущего,
    // уже неактуального кода — останавливаемся.
    if (qrLoginTicketId !== id) return;
    if (Date.now() > expiresAt) {
      $('#authStartQrError').textContent = 'Код устарел — вернитесь на этот экран ещё раз, чтобы получить новый.';
      return;
    }
    try {
      const data = await api(`/api/qr-login/${id}/poll`);
      if (qrLoginTicketId !== id) return; // экран успели закрыть, пока ждали ответ
      if (data.status === 'confirmed' && data.user) {
        stopQrLoginFlow();
        onAuthed(data.user);
        await handleDeepLinkIfPresent();
        return;
      }
      if (data.status === 'expired') {
        $('#authStartQrError').textContent = 'Код устарел — вернитесь на этот экран ещё раз, чтобы получить новый.';
        return;
      }
    } catch (e) { /* сетевая заминка — просто попробуем ещё раз следующим тиком */ }
    qrLoginPollTimer = setTimeout(tick, 2000);
  };
  qrLoginPollTimer = setTimeout(tick, 2000);
}

async function checkSession() {
  try {
    const { user } = await api('/api/me');
    onAuthed(user);
    await handleDeepLinkIfPresent();
  } catch (e) {
    if (!state.user && typeof appLockOnNoUser === 'function') appLockOnNoUser();
    $('#bootScreen').classList.add('hidden');
    $('#authScreen').classList.remove('hidden');
    $('#appScreen').classList.add('hidden');
    showAuthStep('start');
  }
}

// Свой фон в чатах, привязанный к аккаунту: пусто/undefined — используем
// встроенный по умолчанию (см. --chat-wallpaper в :root, style.css); если у
// пользователя есть загруженная картинка — подставляем её через инлайн-стиль,
// который перекрывает значение из :root для всего документа.
function applyWallpaperPref(value) {
  if (!value) { document.documentElement.style.removeProperty('--chat-wallpaper'); return; }
  const isCssValue = /^(linear-gradient|radial-gradient|url)\(/.test(value);
  document.documentElement.style.setProperty('--chat-wallpaper', isCssValue ? value : `url('${value}')`);
}

// Баннер под папками чатов — сервер сам не присылает то, что пользователь
// уже закрыл (см. GET /api/banner), так что если он ничего не вернул —
// просто прячем блок и всё, дополнительной логики на клиенте не нужно.
async function loadBanner() {
  try {
    const { banner } = await api('/api/banner');
    const el = $('#mainBanner');
    if (!banner) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.innerHTML = `
      <div class="main-banner-img" style="${banner.imageUrl ? `background-image:url('${banner.imageUrl}')` : ''}"></div>
      <div class="main-banner-text">
        <div class="main-banner-title">${escapeHtml(banner.title)}</div>
        ${banner.description ? `<div class="main-banner-desc">${escapeHtml(banner.description)}</div>` : ''}
      </div>
      <button class="main-banner-close" title="Закрыть">✕</button>
    `;
    el.classList.remove('hidden');
    el.querySelector('.main-banner-close').addEventListener('click', async () => {
      el.classList.add('hidden');
      el.innerHTML = '';
      try { await api('/api/banner/dismiss', { method: 'POST', body: { bannerId: banner.id } }); } catch (e) { /* не критично */ }
    });
  } catch (e) { /* баннер — не критичная функция, тихо пропускаем при ошибке */ }
}

// Баннер "обновите приложение вручную" — на случай АНДРОИД-приложения,
// установленного ДО того, как в него добавили встроенную автопроверку
// обновлений (см. AppUpdateManager.java и MainActivity в asteria-android).
// Проблема в том, что сама эта проверка живёт внутри уже установленного
// APK — у совсем старых версий такого кода попросту нет, и никакой сервер
// не может заставить их сам к себе постучаться. Но APK — это лишь тонкая
// обёртка (WebView) вокруг этой самой веб-страницы, а её сервер отдаёт
// каждый раз заново, независимо от версии приложения. Поэтому проверку
// дублируем и здесь: если мы точно внутри Android-приложения (см.
// window.AsteriaNotify — этот мост есть во ВСЕХ версиях приложения, в т.ч.
// самых старых, в отличие от автообновления) и на сервере есть
// опубликованный релиз — показываем баннер со ссылкой на ручное скачивание.
// Для тех, у кого автопроверка уже есть, это просто немного дублирует
// системный диалог — не страшно, баннер можно закрыть, и для того же
// versionCode он больше не покажется (см. localStorage ниже).
async function checkAppUpdateBanner() {
  if (!window.AsteriaNotify) return; // не внутри Android-приложения — тут это ни при чём
  const el = $('#appUpdateBanner');
  if (!el) return;
  try {
    const data = await api('/api/app/version');
    if (!data || !data.available) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    const skippedKey = 'app_update_banner_skipped_version';
    if (Number(localStorage.getItem(skippedKey)) === Number(data.versionCode)) return;
    el.innerHTML = `
      <div class="main-banner-img">⬆️</div>
      <div class="main-banner-text">
        <div class="main-banner-title">Доступна новая версия приложения ${escapeHtml(data.versionName || '')}</div>
        <div class="main-banner-desc">${data.notes ? escapeHtml(data.notes) : 'Если у вас старая версия без автообновления, скачайте новую вручную.'}</div>
      </div>
      <button class="app-update-banner-btn" id="appUpdateBannerDownloadBtn">Скачать</button>
      <button class="main-banner-close" title="Закрыть">✕</button>
    `;
    el.classList.remove('hidden');
    el.querySelector('#appUpdateBannerDownloadBtn').addEventListener('click', () => {
      // Прямая навигация — WebView.setDownloadListener в MainActivity сам
      // подхватит скачивание .apk через системный DownloadManager (файл
      // ляжет в Загрузки, дальше пользователь открывает его и ставит сам,
      // как обычный файл из браузера).
      window.location.href = data.url;
    });
    el.querySelector('.main-banner-close').addEventListener('click', () => {
      localStorage.setItem(skippedKey, String(data.versionCode));
      el.classList.add('hidden');
      el.innerHTML = '';
    });
  } catch (e) { /* не критично, тихо пропускаем */ }
}

function onAuthed(user) {
  state.user = user;
  if (typeof appLockOnAuthed === 'function') appLockOnAuthed(user);
  applyThemePref(user.theme || 'light');
  applyWallpaperPref(user.chatWallpaper || '');
  if (typeof applyLanguagePref === 'function') applyLanguagePref(user.language || 'ru');
  $('#bootScreen').classList.add('hidden');
  $('#authScreen').classList.add('hidden');
  $('#appScreen').classList.remove('hidden');
  renderMyAvatar();
  $('#adminNavBtn').classList.toggle('hidden', !user.isAdmin);
  $('#openAdminFromSettingsBtn').classList.toggle('hidden', !user.isAdmin);
  connectWS();
  loadConversations();
  loadStories();
  loadBanner();
  checkAppUpdateBanner();
  requestNotificationPermission();
  equalizeBottomNavButtonWidths();
  switchSection('chats');
}

/* ---------------- НАВИГАЦИЯ ПО РАЗДЕЛАМ (Чаты/Звонки/Настройки/Админ) ---------------- */

// Порядок вкладок нижней панели — по нему считаем, в какую сторону слайдить
// анимацию перехода (влево/вправо) и куда должна проехать плашка.
const BOTTOM_NAV_ORDER = ['chats', 'calls', 'settings'];
const SECTION_TRANSITION_MS = 280;

function sectionEl(name) {
  return $('#section' + name.charAt(0).toUpperCase() + name.slice(1));
}

// Плавно (крестфейд с приближением, без ухода вбок) переключает видимость
// между двумя из трёх основных вкладок: новый экран слегка "наезжает"
// вперёд (масштаб .94 → 1), старый чуть отступает назад (масштаб → 1.04) —
// без горизонтального сдвига. Для остальных разделов (профиль, канал,
// админка, настройки-подстраницы) поведение не меняем — мгновенно, как раньше.
function animateTabSwitch(previous, name) {
  const prevEl = sectionEl(previous);
  const nextEl = sectionEl(name);
  nextEl.classList.remove('hidden');
  nextEl.classList.add('section-enter-zoom');
  void nextEl.offsetWidth; // форсируем reflow, чтобы браузер зафиксировал стартовое состояние перед анимацией
  prevEl.classList.add('section-exit-zoom');
  requestAnimationFrame(() => {
    nextEl.classList.remove('section-enter-zoom');
  });
  setTimeout(() => {
    prevEl.classList.add('hidden');
    prevEl.classList.remove('section-exit-zoom');
  }, SECTION_TRANSITION_MS);
}

function switchSection(name) {
  // При каждом переключении раздела (в т.ч. открытии "Чатов") пересчитываем
  // реальную высоту экрана — на случай, если она успела разъехаться с тем,
  // что было посчитано при первой загрузке страницы (актуально для iOS,
  // где размеры видимой области могут "устаканиться" не сразу, особенно
  // в приложении с экрана "Домой").
  setRealViewportHeight();
  // Иногда сразу после переключения раздела (особенно первого открытия
  // "Чатов" после запуска) реальная высота ещё не успевает "устояться" —
  // подстраховываемся повторным пересчётом чуть позже.
  setTimeout(() => { setRealViewportHeight(); }, 100);
  const previous = state.activeSection;
  // Подстраховка: если пользователь ушёл с открытого пункта настроек сразу
  // через нижнюю плашку (не через "Назад"), сбрасываем флаг, иначе плашка
  // так и останется скрытой на новом разделе.
  if (name !== 'settings') $('#appScreen').classList.remove('settings-sub-open');
  const subpages = ['profile', 'channel', 'storyCreate'];
  if (subpages.includes(name) && !subpages.includes(previous)) state.subpageReturnSection = previous || 'chats';
  state.activeSection = name;
  // БАГ: нижняя плавающая плашка навигации пряталась только через классы
  // .chat-open/.settings-sub-open на #appScreen (см. CSS) — у самой
  // страницы профиля/канала (subpages выше) такого класса не было вовсе.
  // В обычном сценарии (открыть профиль контакта ИЗ уже открытого чата)
  // это маскировалось: .chat-open уже был на #appScreen с более раннего
  // шага и просто "случайно" не снимался. Но если профиль открывается не
  // из чата — например, по прямой ссылке /u/username после сканирования
  // чужого QR-кода — .chat-open никогда не выставлялся, и плашка
  // оставалась поверх экрана профиля. Выставляем/снимаем отдельный класс
  // явно, при каждом переключении раздела, а не полагаясь на побочный
  // эффект чужого состояния.
  $('#appScreen').classList.toggle('subpage-open', subpages.includes(name));

  // Анимация переключения (крестфейд/приближение) — CSS для неё описан
  // только в мобильной медиа-выборке (max-width: 860px; на десктопе другой
  // макет — с постоянно видимой боковой панелью, а не отдельными полноэкранными
  // вкладками). Поэтому и включаем её только на этой ширине; на десктопе, где
  // этих CSS-стилей нет, анимация всё равно не сыграла бы, зато старый и
  // новый экран на время "хвоста" анимации оставались бы видны оба сразу —
  // это и было причиной бага. На десктопе — как раньше, мгновенно.
  const isMobileLayout = window.matchMedia('(max-width: 860px)').matches;
  const bothAreMainTabs = BOTTOM_NAV_ORDER.includes(previous) && BOTTOM_NAV_ORDER.includes(name);
  if (isMobileLayout && bothAreMainTabs && previous !== name) {
    animateTabSwitch(previous, name);
  } else {
    ['chats', 'calls', 'settings', 'admin', 'profile', 'channel', 'storyCreate'].forEach((s) => {
      sectionEl(s).classList.toggle('hidden', s !== name);
    });
  }

  $all('.nav-rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.section === name));
  $all('.bottom-nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.section === name));
  moveBottomNavIndicator(name, true);

  if (name === 'calls') loadCallHistory();
  if (name === 'settings') openSettingsPage();
  if (name === 'admin') openAdminPanel();
  reportActiveChatToNative();
  updateNativeSystemBars();
}

/* ---------------- ПЛАШКА-ИНДИКАТОР НИЖНЕЙ ПАНЕЛИ (drag + snap) ---------------- */

// Раньше каждая кнопка нижней панели была шириной ровно под свой текст —
// "Чаты"/"Звонки" почти одинаковые, а "Настройки" заметно шире. Из-за этого
// при переезде на "Настройки" плашка не просто скользила, а на глазах
// СИЛЬНО раздувалась по ширине (transition на width длится всё те же .32s,
// что и transform, но т.к. width не композитится GPU так же гладко, как
// transform, — это выглядело как рывками "наполняющийся" индикатор, а не
// как ровный переезд, каким он выглядит между Чатами и Звонками, где
// разница ширины кнопок минимальна). Чиним не анимацию, а первопричину —
// делаем все кнопки одной (максимальной) ширины, тогда плашке вообще не
// нужно менять width при переключении, она только едет (translateX),
// независимо от языка интерфейса и длины подписи.
function equalizeBottomNavButtonWidths() {
  const nav = $('#bottomNav');
  if (!nav || getComputedStyle(nav).display === 'none') return;
  const btns = $all('.bottom-nav-btn');
  if (!btns.length) return;
  btns.forEach((b) => { b.style.width = ''; }); // сбрасываем, чтобы измерить настоящую "естественную" ширину
  const maxWidth = Math.max(...btns.map((b) => b.getBoundingClientRect().width));
  btns.forEach((b) => { b.style.width = maxWidth + 'px'; });
}

// Ставит плашку под кнопку нужного раздела (по фактическим размерам кнопки
// на экране, а не по номеру — так не важно, все ли вкладки одной ширины).
// animate=false используется во время активного перетаскивания пальцем,
// когда позиция уже выставляется напрямую в px в другом месте.
function moveBottomNavIndicator(name, animate) {
  const nav = $('#bottomNav');
  const indicator = $('#bottomNavIndicator');
  if (!nav || !indicator) return;
  // Панель бывает скрыта (display:none) — открыт чат или подстраница
  // настроек, см. #appScreen.chat-open/.settings-sub-open. getBoundingClientRect
  // на скрытых элементах вернёт нули, и плашка "запомнит" нулевые размеры —
  // поэтому просто ничего не делаем, пока панель не видна; актуальную
  // позицию досчитают места, которые снова её показывают (см. вызовы после
  // closeSettingsSubpage()/снятия .chat-open).
  if (getComputedStyle(nav).display === 'none') return;
  const btn = nav.querySelector(`.bottom-nav-btn[data-section="${name}"]`);
  if (!btn) return;
  const navRect = nav.getBoundingClientRect();
  const btnRect = btn.getBoundingClientRect();
  const left = btnRect.left - navRect.left - 6; // -6: padding контейнера, indicator уже стоит на inset 6px
  indicator.classList.toggle('dragging', !animate);
  indicator.style.width = btnRect.width + 'px';
  indicator.style.transform = `translateX(${left}px)`;
}

// Перетаскивание плашки пальцем/мышью внутри белой (полупрозрачной) капсулы
// нижней панели. Жест стартует, только если палец коснулся именно активной
// (подсвеченной) кнопки — визуально это и есть "взять плашку". Пока сдвиг
// меньше небольшого порога, это считается обычным тапом и не мешает
// стандартному клику по кнопке; как только порог пройден — включается
// перетаскивание, а обычный клик на этот раз подавляется, чтобы не
// сработать вдобавок к обработке отпускания пальца.
(function setupBottomNavDrag() {
  const nav = $('#bottomNav');
  const indicator = $('#bottomNavIndicator');
  if (!nav || !indicator) return;
  const DRAG_THRESHOLD_PX = 6;
  let pointerId = null;
  let tracking = false;   // палец на активной кнопке, ждём — тап это или начало драга
  let dragging = false;   // порог пройден, плашка реально едет за пальцем
  let suppressNextClick = false;
  let startX = 0;
  let startLeft = 0;
  let indicatorWidth = 0;

  function buttonCenters() {
    const navRect = nav.getBoundingClientRect();
    return Array.from(nav.querySelectorAll('.bottom-nav-btn')).map((btn) => {
      const r = btn.getBoundingClientRect();
      return { name: btn.dataset.section, el: btn, center: r.left - navRect.left + r.width / 2, width: r.width };
    });
  }

  // Пока плашка в воздухе — красим белым текст той кнопки, над которой
  // сейчас находится центр плашки, остальные красим обратно в серый (кроме
  // реально активной вкладки — её .active трогать не нужно, она и так белая,
  // пока драг не завершится переключением на другой раздел). Заодно на
  // лету подгоняем ширину самой плашки под ширину этой кнопки — так она
  // визуально "переливается" из одной вкладки в другую, а не тащится одним
  // и тем же размером через все три.
  function highlightNearestDuringDrag(currentCenter) {
    const centers = buttonCenters();
    let nearest = centers[0];
    let best = Infinity;
    centers.forEach((c) => { const d = Math.abs(c.center - currentCenter); if (d < best) { best = d; nearest = c; } });
    centers.forEach((c) => c.el.classList.toggle('drag-highlight', c === nearest));
    if (nearest) indicator.style.width = nearest.width + 'px';
    return nearest;
  }

  function clearDragHighlight() {
    nav.querySelectorAll('.bottom-nav-btn.drag-highlight').forEach((el) => el.classList.remove('drag-highlight'));
  }

  nav.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.bottom-nav-btn');
    if (!btn || !btn.classList.contains('active')) return; // тащить можно только саму плашку (активную кнопку)
    tracking = true;
    dragging = false;
    clearDragHighlight();
    nav.classList.add('holding'); // визуальная реакция на удержание
    pointerId = e.pointerId;
    startX = e.clientX;
    startLeft = parseFloat((indicator.style.transform.match(/-?[\d.]+/) || [0])[0]) || 0;
    indicatorWidth = indicator.getBoundingClientRect().width;
  });

  nav.addEventListener('pointermove', (e) => {
    if (!tracking || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    if (!dragging && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
    if (!dragging) {
      dragging = true;
      suppressNextClick = true;
      indicator.classList.add('dragging');
      nav.classList.add('dragging-nav');
      try { nav.setPointerCapture(pointerId); } catch (err) { /* не критично */ }
    }
    const navRect = nav.getBoundingClientRect();
    // Плашка на лету меняет ширину под ту кнопку, над которой сейчас
    // находится (см. highlightNearestDuringDrag) — поэтому границы
    // перетаскивания считаем по ЕЁ ТЕКУЩЕЙ ширине, а не по той, что была в
    // момент начала жеста, иначе у самой правой (обычно самой широкой)
    // кнопки плашка могла бы вылезти за край капсулы.
    const liveWidth = parseFloat(indicator.style.width) || indicatorWidth;
    const maxLeft = Math.max(0, navRect.width - 12 - liveWidth); // 12 = левый+правый inset панели (6px + 6px)
    const nextLeft = Math.min(Math.max(0, startLeft + dx), maxLeft);
    indicator.style.transform = `translateX(${nextLeft}px)`;
    highlightNearestDuringDrag(nextLeft + liveWidth / 2);
  });

  function finishDrag(e) {
    nav.classList.remove('holding');
    if (!tracking) return;
    tracking = false;
    if (!dragging) return; // обычный тап — обычный click сам всё сделает
    dragging = false;
    indicator.classList.remove('dragging');
    nav.classList.remove('dragging-nav');
    clearDragHighlight();
    try { nav.releasePointerCapture(pointerId); } catch (err) { /* не критично */ }
    const currentLeft = parseFloat((indicator.style.transform.match(/-?[\d.]+/) || [0])[0]) || 0;
    const liveWidth = parseFloat(indicator.style.width) || indicatorWidth;
    const currentCenter = currentLeft + liveWidth / 2;
    const centers = buttonCenters();
    let nearest = centers[0];
    let best = Infinity;
    centers.forEach((c) => { const d = Math.abs(c.center - currentCenter); if (d < best) { best = d; nearest = c; } });
    if (nearest && nearest.name && nearest.name !== state.activeSection) {
      switchSection(nearest.name); // сам доедет плавно и переключит раздел
    } else {
      moveBottomNavIndicator(state.activeSection, true); // отпустили "мимо" — плашка возвращается на место
    }
  }

  nav.addEventListener('pointerup', finishDrag);
  nav.addEventListener('pointercancel', finishDrag);
  // Долгое нажатие на Android не должно открывать системное контекстное меню.
  nav.addEventListener('contextmenu', (e) => e.preventDefault());

  // Клик, которым закончился перетаскивание (а не обычный тап), нужно один
  // раз погасить — переключение раздела уже произошло в finishDrag().
  nav.addEventListener('click', (e) => {
    if (!suppressNextClick) return;
    suppressNextClick = false;
    if (e.target.closest('.bottom-nav-btn')) { e.stopPropagation(); e.preventDefault(); }
  }, true);
})();

// БАГ «при переключении языка плашка экранов сужается только после обновления
// страницы»: ширины кнопок нижней панели фиксируются в px под подписи ТЕКУЩЕГО
// языка (equalizeBottomNavButtonWidths), а при смене языка подписи меняются
// (длина «Настройки» ≠ «Settings»), и ни ширины кнопок, ни плашка не
// пересчитывались — до перезагрузки. Вызывается из applyLanguagePref (i18n.js).
function relayoutBottomNav() {
  equalizeBottomNavButtonWidths();
  moveBottomNavIndicator(state.activeSection || 'chats', false);
}
window.relayoutBottomNav = relayoutBottomNav;
window.addEventListener('resize', relayoutBottomNav);
// Панель бывает скрыта (открыт чат / подстраница настроек): язык могли сменить,
// пока она была display:none, и измерить её было нельзя. Когда она снова
// появляется, её размер меняется с 0 — пересчитываем.
if (window.ResizeObserver && $('#bottomNav')) {
  let navRelayoutRaf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(navRelayoutRaf);
    navRelayoutRaf = requestAnimationFrame(relayoutBottomNav);
  }).observe($('#bottomNav'));
}

$all('.nav-rail-btn[data-section]').forEach((btn) => btn.addEventListener('click', () => switchSection(btn.dataset.section)));
$all('.bottom-nav-btn[data-section]').forEach((btn) => btn.addEventListener('click', () => switchSection(btn.dataset.section)));
$('#myAvatar').addEventListener('click', () => switchSection('settings'));
$('#adminBackBtn').addEventListener('click', () => switchSection('chats'));
$('#profileBackBtn').addEventListener('click', () => switchSection(state.subpageReturnSection || 'chats'));
$('#channelBackBtn').addEventListener('click', () => {
  // Внутри страницы канала/группы есть свои «экраны» (управление, админы,
  // реакции…) — «Назад» сначала возвращает на уровень выше и только с
  // главного экрана профиля уходит из раздела.
  if (channelNav.view !== 'profile') { channelGoBack(); return; }
  switchSection(state.subpageReturnSection || 'chats');
});
$('#channelMoreBtn').addEventListener('click', () => channelSetView('manage'));
$('#openAdminFromSettingsBtn').addEventListener('click', () => switchSection('admin'));

function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    Notification.requestPermission().then((perm) => {
      if (perm === 'granted') subscribeToPush();
    }).catch(() => {});
  } else if (Notification.permission === 'granted') {
    // Разрешение уже выдано раньше (или подписка ещё не оформлена на этом
    // устройстве/после переустановки) — досогласовываем подписку молча,
    // без нового запроса у пользователя.
    subscribeToPush();
  }
}

// ---------- Web Push (уведомления в закрытом виде на iOS/Android/десктопе) ----------
// В приложении для Android (WebView-обёртка) свой нативный фоновый сервис
// (AsteriaPushService) — у него отдельное постоянное WS-соединение, ему
// Web Push не нужен и даже вреден (дублировал бы уведомления), поэтому
// внутри приложения просто выходим (см. window.AsteriaNotify проверку в
// notifyNewMessage выше — тот же признак "мы внутри нативного приложения").
function urlBase64ToUint8Array(base64url) {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function subscribeToPush() {
  if (window.AsteriaNotify) return; // нативное Android-приложение — см. комментарий выше
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return; // Safari < 16.4, старые браузеры
  if (Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const keyRes = await fetch('/api/push/vapid-public-key');
      if (!keyRes.ok) return;
      const { publicKey } = await keyRes.json();
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true, // обязателен в Safari/iOS — каждый push должен приводить к видимому уведомлению
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    const json = sub.toJSON();
    const subscribeRes = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
    });
    if (!subscribeRes.ok) {
      const errBody = await subscribeRes.json().catch(() => ({}));
      console.error('Сервер отклонил push-подписку:', subscribeRes.status, errBody.error, 'p256dh:', json.keys && json.keys.p256dh, 'auth:', json.keys && json.keys.auth);
      // Ключи, которые вернул сам браузер, сервер посчитал невалидными —
      // значит эта конкретная подписка в браузере испорчена (WebKit иногда
      // "залипает" на такой). Разрешение на уведомления при этом остаётся
      // выданным, поэтому пробуем один раз пересоздать подписку с нуля.
      try {
        await sub.unsubscribe();
        const keyRes2 = await fetch('/api/push/vapid-public-key');
        const { publicKey: publicKey2 } = await keyRes2.json();
        const freshSub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey2),
        });
        const freshJson = freshSub.toJSON();
        const retryRes = await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: freshJson.endpoint, keys: freshJson.keys }),
        });
        console.log('Повторная попытка подписки:', retryRes.ok ? 'успешно' : 'снова отклонена сервером');
      } catch (retryErr) {
        console.error('Не удалось пересоздать push-подписку:', retryErr);
      }
    }
  } catch (e) {
    // Не критично — если push не поддерживается или пользователь позже
    // отменит разрешение на уровне ОС, приложение продолжает работать как
    // раньше, просто без фоновых уведомлений.
    console.warn('Не удалось оформить push-подписку:', e);
  }
}

let activeCallNotification = null;

// ФИКС: уведомления показывались только для новых сообщений (см. выше), но
// не для входящих звонков — если человек не смотрел в этот момент на вкладку
// с открытым Asteria, он просто не узнавал о звонке, пока не откроет вкладку
// сам. Теперь входящий звонок тоже даёт системное уведомление, как и
// сообщение — с именем звонящего (сервер теперь присылает его прямо в
// сигнале, см. callerName в call-offer) и явной пометкой "звонок", чтобы не
// перепутать с обычным сообщением.
function notifyIncomingCall(msg) {
  // В приложении для Android звонок обрабатывает свой нативный фоновый
  // сервис (AsteriaPushService) — у него отдельное WS-соединение и своё
  // системное уведомление. Показывать уведомление ещё раз через веб-страницу
  // означало бы показать его дважды.
  if (window.AsteriaNotify) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const name = msg.callerName || 'Неизвестный';
    const n = new Notification(`📞 ${name}`, {
      body: msg.kind === 'video' ? 'Входящий видеозвонок' : 'Входящий аудиозвонок',
      tag: 'call-' + msg.callId,
      requireInteraction: true,
      renotify: true,
    });
    n.onclick = () => { window.focus(); n.close(); };
    activeCallNotification = n;
  } catch (e) { /* уведомления недоступны — просто игнорируем */ }
}

function closeActiveCallNotification() {
  if (activeCallNotification) { try { activeCallNotification.close(); } catch (e) {} activeCallNotification = null; }
}

function notifyNewMessage(message) {
  if (message.senderId === state.user.id) return;
  const isViewingThisChat = state.activeSection === 'chats' && state.activeConvId === message.conversationId && document.visibilityState === 'visible' && document.hasFocus();
  if (isViewingThisChat) return;
  const conv = state.conversations.find((c) => c.id === message.conversationId);
  const title = conv ? (conv.type === 'channel' ? `📢 ${conv.name}` : conv.type === 'group' ? `👥 ${conv.name}` : (conv.peer ? (conv.peerNickname || conv.peer.displayName) : 'Asteria')) : 'Asteria';
  const body = previewText(message);

  // Внутри приложения для Android свой системный showNotification берёт на
  // себя нативный фоновый сервис AsteriaPushService — у него собственное
  // WS-соединение с сервером и он сам решает, показывать ли уведомление
  // (используя ровно то же условие isViewingThisChat, которое сообщает
  // reportActiveChatToNative()). Показывать уведомление здесь ещё раз —
  // значит показать его дважды, поэтому в приложении просто выходим.
  if (window.AsteriaNotify) return;

  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag: message.conversationId, renotify: true });
    n.onclick = () => {
      window.focus();
      switchSection('chats');
      openConversation(message.conversationId);
      n.close();
    };
  } catch (e) { /* уведомления недоступны — просто игнорируем */ }
}

// Вызывается из нативного Android-кода (MainActivity.tryOpenPendingConversation)
// когда пользователь тапнул по системному уведомлению — ждёт, пока
// приложение полностью подгрузит свои данные, и открывает нужный чат.
function openConversationFromAndroid(convId, attemptsLeft) {
  if (!convId) return;
  if (attemptsLeft === undefined) attemptsLeft = 20;
  if (!state.user || !state.conversations.length) {
    if (attemptsLeft <= 0) return;
    setTimeout(() => openConversationFromAndroid(convId, attemptsLeft - 1), 300);
    return;
  }
  switchSection('chats');
  openConversation(convId);
}
window.openConversationFromAndroid = openConversationFromAndroid;

// Вызывается из нативного Android-кода (MainActivity.tryAutoAcceptCall),
// когда пользователь нажал "Принять" прямо в системном уведомлении о
// звонке, даже не открывая приложение вручную (см. showCallNotification в
// AsteriaPushService.java). Сам SDP-оффер приходит отдельно по WebSocket
// (resendRingingCallsTo на сервере досылает его повторно при каждом новом
// подключении) — здесь просто ждём, пока он появится в pendingOffer с тем
// же callId, и сразу принимаем, вместо того чтобы показывать обычный
// экран "Входящий звонок" с кнопками.
function autoAcceptCallFromAndroid(callId, callerId, attemptsLeft) {
  if (!callId) return;
  if (attemptsLeft === undefined) attemptsLeft = 30;
  if (pendingOffer && pendingOffer.callId === callId) {
    acceptIncomingCall();
    return;
  }
  // Если уже идёт какой-то другой звонок — не мешаем ему; если попытки
  // кончились — скорее всего, звонящий отменил вызов быстрее, чем мы
  // успели дождаться повторного call-offer, тихо прекращаем попытки.
  if (state.currentCallPeerId) return;
  if (attemptsLeft <= 0) return;
  setTimeout(() => autoAcceptCallFromAndroid(callId, callerId, attemptsLeft - 1), 300);
}
window.autoAcceptCallFromAndroid = autoAcceptCallFromAndroid;

$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  // Выход — стираем и копию чатов/сообщений/иконок на телефоне
  if (window.OfflineStore) await window.OfflineStore.clear();
  location.reload();
});

/* ---------------- WEBSOCKET ---------------- */

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/`);
  state.ws = ws;
  ws.addEventListener('message', (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch (e) { return; }
    handleWSEvent(msg);
  });
  ws.addEventListener('open', () => { if (window.OfflineStore) window.OfflineStore.onWsOpen(); });
  ws.addEventListener('close', () => {
    if (window.OfflineStore) window.OfflineStore.onWsClose();
    setTimeout(connectWS, 2000);
  });
}

// Сеть вернулась (или сокет переподключился): сверяем сессию, обновляем чаты и
// дозагружаем сообщения, пришедшие, пока мы были без связи.
async function resyncAfterReconnect() {
  if (!state.user || state.resyncing) return;
  state.resyncing = true;
  try {
    let resp;
    try { resp = await api('/api/me'); } catch (e) {
      if (e instanceof TypeError) return;          // сети по-прежнему нет
      location.reload();                            // сессия истекла — обычный вход
      return;
    }
    if (resp.__offline) return;
    state.user = Object.assign({}, state.user, resp.user);
    renderMyAvatar();
    await loadConversations();
    loadStories().catch(() => {});
    loadBanner();
    // История всех чатов могла измениться — при следующем открытии перезапросим и склеим по id.
    Object.keys(state.messagesLoaded).forEach((id) => { state.messagesLoaded[id] = false; });
    const convId = state.activeConvId;
    if (convId) {
      const { messages, hasMore } = await api(`/api/conversations/${convId}/messages?limit=${MESSAGES_PAGE_SIZE}`);
      const byId = new Map(messages.map((m) => [m.id, m]));
      const serverAirIds = new Set(messages.map((m) => m.meta && m.meta.airpinId).filter(Boolean));
      (state.messages[convId] || []).forEach((m) => {
        if (m.meta && m.meta.airpinId && serverAirIds.has(m.meta.airpinId) && String(m.id).startsWith('airpin:')) return;
        if (!byId.has(m.id)) byId.set(m.id, m);
      });
      state.messages[convId] = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
      state.messagesHasMore[convId] = !!hasMore;
      state.messagesLoaded[convId] = true;
      if (state.activeConvId === convId) renderMessages({ preserveScroll: true });
    }
  } catch (e) {
    /* попробуем при следующем переподключении */
  } finally {
    state.resyncing = false;
  }
}
window.resyncAfterReconnect = resyncAfterReconnect;

function handleWSEvent(msg) {
  if (msg.type === 'message') {
    const convId = msg.message.conversationId;
    if (window.AirPin && msg.message.meta && msg.message.meta.airpinId) window.AirPin.onServerMessage(msg.message);
    if (!state.messages[convId]) state.messages[convId] = [];
    if (msg.message.senderId === state.user.id) dropEchoedPending(convId, msg.message.msgType);
    state.messages[convId].push(msg.message);
    bumpConversation(convId, msg.message);
    if (state.activeConvId === convId) { appendMessageBubble(msg.message); markConversationRead(convId); }
    else renderConvList();
    notifyNewMessage(msg.message);
  } else if (msg.type === 'read-update') {
    const conv = state.conversations.find((c) => c.id === msg.conversationId);
    if (conv) {
      conv.reads = { ...(conv.reads || {}), [msg.userId]: msg.at };
      if (state.activeConvId === msg.conversationId) renderMessages({ preserveScroll: true });
    }
  } else if (msg.type === 'message-edit') {
    const convId = msg.message.conversationId;
    const list = state.messages[convId];
    if (list) {
      const idx = list.findIndex((m) => m.id === msg.message.id);
      if (idx !== -1) list[idx] = msg.message;
    }
    if (state.activeConvId === convId && !rerenderMessageInPlace(msg.message.id)) renderMessages({ preserveScroll: true });
    const cIdx = state.conversations.findIndex((c) => c.id === convId);
    if (cIdx !== -1 && state.conversations[cIdx].pinnedMessage && state.conversations[cIdx].pinnedMessage.id === msg.message.id) {
      state.conversations[cIdx].pinnedMessage = msg.message;
      if (state.activeConvId === convId) renderPinnedBar(state.conversations[cIdx]);
    }
  } else if (msg.type === 'pin-update') {
    const cIdx = state.conversations.findIndex((c) => c.id === msg.conversationId);
    if (cIdx !== -1) {
      state.conversations[cIdx] = { ...state.conversations[cIdx], pinnedMessage: msg.pinnedMessage, pinnedMessageId: msg.pinnedMessage ? msg.pinnedMessage.id : null };
      if (state.activeConvId === msg.conversationId) renderPinnedBar(state.conversations[cIdx]);
    }
  } else if (msg.type === 'message-delete') {
    const list = state.messages[msg.conversationId];
    if (list) {
      const idx = list.findIndex((m) => m.id === msg.messageId);
      if (idx !== -1) list.splice(idx, 1);
    }
    if (state.activeConvId === msg.conversationId) renderMessages();
  } else if (msg.type === 'story-reaction') {
    showToast(`${msg.userName || 'Кто-то'} отреагировал(а) ${msg.emoji} на вашу историю`);
    if (typeof loadStories === 'function') loadStories();
  } else if (msg.type === 'reaction-update') {
    const list = state.messages[msg.conversationId];
    if (list) {
      const m = list.find((mm) => mm.id === msg.messageId);
      if (m) {
        // Анимация — только у того, кто сам поставил реакцию (см. sendReaction /
        // playReactionBurst); у остальных участников плашка просто обновляется.
        m.reactions = msg.reactions;
      }
    }
    if (state.activeConvId === msg.conversationId && !rerenderMessageInPlace(msg.messageId)) {
      renderMessages({ preserveScroll: true });
    }
  } else if (msg.type === 'poll-update') {
    const list = state.messages[msg.conversationId];
    if (list) {
      const m = list.find((mm) => mm.id === msg.messageId);
      if (m && m.meta) m.meta = { ...m.meta, votes: msg.votes };
    }
    if (state.activeConvId === msg.conversationId && !rerenderMessageInPlace(msg.messageId)) {
      renderMessages({ preserveScroll: true });
    }
  } else if (msg.type === 'message-blocked') {
    alert(msg.reason === 'you-blocked'
      ? 'Вы заблокировали этого пользователя. Разблокируйте его в профиле, чтобы писать ему.'
      : msg.reason === 'privacy'
        ? 'Этот пользователь ограничил входящие сообщения.'
        : 'Сообщение не доставлено.');
  } else if (msg.type === 'conversation-updated') {
    mergeConversation(msg.conversation);
  } else if (msg.type === 'history-cleared') {
    applyHistoryCleared(msg.conversationId);
  } else if (msg.type === 'conversation-deleted') {
    state.conversations = state.conversations.filter((c) => c.id !== msg.conversationId);
    if (state.activeSection === 'channel' && channelNav.convId === msg.conversationId) {
      switchSection(state.subpageReturnSection || 'chats');
    }
    if (state.activeConvId === msg.conversationId) {
      closeActiveChat();
      alert('Этот чат/канал был удалён');
    }
    renderConvList();
  } else if (msg.type === 'admin-granted') {
    state.user.isAdmin = true;
    $('#adminNavBtn').classList.remove('hidden');
    $('#openAdminFromSettingsBtn').classList.remove('hidden');
    alert('🔑 Вам выданы права администратора! В меню слева (или в Настройках на телефоне) появился раздел «Админ».');
  } else if (msg.type === 'admin-revoked') {
    state.user.isAdmin = false;
    $('#adminNavBtn').classList.add('hidden');
    $('#openAdminFromSettingsBtn').classList.add('hidden');
    if (state.activeSection === 'admin') switchSection('chats');
  } else if (msg.type === 'account-deleted') {
    alert('Ваш аккаунт был удалён администратором.');
    location.reload();
  } else if (msg.type === 'typing') {
    if (state.activeConvId === msg.conversationId) {
      $('#typingIndicator').classList.remove('hidden');
      clearTimeout(state.typingTimeout);
      state.typingTimeout = setTimeout(() => $('#typingIndicator').classList.add('hidden'), 2000);
    }
  } else if (msg.type === 'presence') {
    const c = state.conversations.find((c) => c.peer && c.peer.id === msg.userId);
    if (c) { c.peer.online = msg.online; if (state.activeConvId === c.id) renderChatHeader(c); }
  } else if (['call-offer','call-answer','call-ice','call-end','call-decline','call-media-toggle','call-taken-elsewhere'].includes(msg.type)) {
    handleCallSignal(msg);
  } else if (msg.type === 'group-call-count') {
    const conv = state.conversations.find((c) => c.id === msg.conversationId);
    if (conv) conv.groupCallCount = msg.count;
    if (state.activeConvId === msg.conversationId) updateGroupCallButton(conv);
  } else if (['group-call-state','group-call-peer-joined','group-call-peer-left','group-call-offer','group-call-answer','group-call-ice'].includes(msg.type)) {
    handleGroupCallSignal(msg);
  }
}

function mergeConversation(patch) {
  const conv = state.conversations.find((c) => c.id === patch.id);
  if (conv) Object.assign(conv, patch);
  renderConvList();
  if (state.activeConvId === patch.id) {
    renderChatHeader(conv || patch);
    updateComposerVisibility(conv || patch);
  }
  // Открытая страница этого канала/группы обновляется «вживую» (права,
  // список админов, реакции) — но не на экранах с полями ввода, чтобы не
  // стирать то, что человек сейчас печатает.
  if (state.activeSection === 'channel' && channelNav.convId === patch.id
      && ['profile', 'manage', 'admins', 'reactions'].includes(channelNav.view)) {
    renderChannelView(channelNav.view === 'reactions');
  }
}

function bumpConversation(convId, message) {
  let conv = state.conversations.find((c) => c.id === convId);
  if (conv) {
    conv.lastMessage = message;
    conv.lastMessageAt = message.createdAt;
    if (message.senderId !== state.user.id && state.activeConvId !== convId) {
      conv.unreadCount = (conv.unreadCount || 0) + 1;
    }
  }
  sortConversations();
  renderConvList();
}

/* ---------------- CONVERSATIONS ---------------- */

async function loadConversations() {
  const { conversations } = await api('/api/conversations');
  state.conversations = conversations;
  state.conversationsReady = true;
  sortConversations();
  await loadFolders();
  renderFolderTabs();
  renderConvList();
}

function isPinned(conv) {
  return !!(conv.pinnedBy || []).includes(state.user.id);
}

function sortConversations() {
  state.conversations.sort((a, b) => {
    const pa = isPinned(a) ? 1 : 0;
    const pb = isPinned(b) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return (b.lastMessageAt || 0) - (a.lastMessageAt || 0);
  });
}

async function togglePin(conv) {
  const pinned = !isPinned(conv);
  try {
    const { conversation } = await api(`/api/conversations/${conv.id}/pin`, { method: 'POST', body: { pinned } });
    mergeConversation(conversation);
    sortConversations();
    renderConvList();
  } catch (err) { alert(err.message); }
}

function convTitle(conv) {
  if (conv.type === 'channel' || conv.type === 'group') return conv.name;
  return conv.peer ? (conv.peerNickname || conv.peer.displayName) : '?';
}

function visibleConversations() {
  if (!state.activeFolderId) return state.conversations;
  const folder = state.folders.find((f) => f.id === state.activeFolderId);
  if (!folder) return state.conversations;
  const idSet = new Set(folder.convIds || []);
  return state.conversations.filter((c) => idSet.has(c.id));
}

function buildConvItem(conv) {
  const pinned = isPinned(conv);
  const div = document.createElement('div');
  div.className = 'conv-item' + (conv.id === state.activeConvId ? ' active' : '') + (pinned ? ' pinned' : '');
  const av = document.createElement('div');
  av.className = 'avatar';
  const title = convTitle(conv);
  const dmAvatarUrl = conv.type === 'dm' && conv.peer ? conv.peer.avatar : '';
  const chAvatarUrl = (conv.type === 'channel' || conv.type === 'group') ? conv.avatar : '';
  const avatarUrl = dmAvatarUrl || chAvatarUrl;
  if (avatarUrl) {
    av.style.cssText = avatarStyle(conv.type === 'dm' ? conv.peer : conv);
  } else {
    av.textContent = initials(title);
  }
  if (conv.type === 'dm') toggleAvatarRing(av, conv.peer);
  div.appendChild(av);
  const meta = document.createElement('div');
  meta.className = 'conv-meta';
  const preview = conv.lastMessage ? previewText(conv.lastMessage) : (conv.type === 'channel' ? 'Канал' : conv.type === 'group' ? 'Группа' : 'Нет сообщений');
  const nameBadge = conv.type === 'dm' ? verifiedBadge(conv.peer) : verifiedBadge(conv) + rknBadge(conv);
  const typeIcon = conv.type === 'channel' ? ' 📢' : conv.type === 'group' ? ' 👥' : '';
  const timeHtml = conv.lastMessageAt ? `<span class="conv-time">${convListTimeLabel(conv.lastMessageAt)}</span>` : '';
  meta.innerHTML = `<div class="conv-name"><span class="conv-name-title">${pinned ? '📌 ' : ''}${escapeHtml(title)}${nameBadge}${typeIcon}</span><span class="conv-name-right">${timeHtml}</span></div><div class="conv-last">${escapeHtml(preview)}</div>`;
  div.appendChild(meta);
  // Бейдж непрочитанных — отдельная колонка справа от .conv-meta, а не
  // часть верхней строки (см. .conv-badge-col в style.css): благодаря
  // align-items: center на .conv-item он центрируется по всей высоте
  // элемента, а не "прилипает" наверх и не расплющивается рядом со временем.
  if (conv.unreadCount) {
    const badgeCol = document.createElement('div');
    badgeCol.className = 'conv-badge-col';
    badgeCol.innerHTML = `<span class="conv-badge">${conv.unreadCount > 99 ? '99+' : conv.unreadCount}</span>`;
    div.appendChild(badgeCol);
  }

  // Быстрая кнопка закрепления по наведению убрана: закрепить/открепить чат
  // теперь можно только через контекстное меню по долгому нажатию/ПКМ
  // (см. openConvContextMenu ниже — там уже есть пункт "Закрепить").

  attachLongPress(div, (e) => openConvContextMenu(e, conv), () => openConversation(conv.id));
  return div;
}

function renderConvList() {
  const el = $('#convList');
  // renderConvList() перевызывается очень часто в фоне (новое сообщение,
  // изменение unreadCount, события WebSocket и т.д.) — el.innerHTML = ''
  // сам по себе сбрасывает scrollTop контейнера в 0. Без сохранения/восстановления
  // позиции список бы "прыгал" наверх прямо во время скролла пользователя.
  const savedScrollTop = el.scrollTop;
  el.innerHTML = '';
  visibleConversations().forEach((conv) => el.appendChild(buildConvItem(conv)));
  el.scrollTop = savedScrollTop;
}

// ---- Единый поиск: свои чаты (локально) + глобальный поиск по каналам и ботам ----
let chatsSearchChannelsCache = null;
let chatsSearchBotsCache = null;
let chatsSearchDebounce = null;
function chatsSearchActive() { return $('#chatsGlobalSearchInput').value.trim().length > 0; }
async function runChatsSearch() {
  const q = $('#chatsGlobalSearchInput').value.trim();
  const resEl = $('#chatsSearchResults');
  if (!q) {
    resEl.classList.add('hidden');
    $('#chatsDefaultView').classList.remove('hidden');
    return;
  }
  $('#chatsDefaultView').classList.add('hidden');
  resEl.classList.remove('hidden');
  const qLower = q.toLowerCase();

  const localMatches = state.conversations.filter((c) => convTitle(c).toLowerCase().includes(qLower));

  if (!chatsSearchChannelsCache) {
    try { chatsSearchChannelsCache = (await api('/api/channels')).channels; } catch (e) { chatsSearchChannelsCache = []; }
  }
  if (!chatsSearchBotsCache) {
    try { chatsSearchBotsCache = (await api('/api/bots')).bots; } catch (e) { chatsSearchBotsCache = []; }
  }
  const localIds = new Set(state.conversations.map((c) => c.id));
  const channelMatches = chatsSearchChannelsCache.filter((c) => !localIds.has(c.id) && c.name.toLowerCase().includes(qLower));
  const botMatches = chatsSearchBotsCache.filter((b) =>
    !localIds.has(b.id) && (b.username.toLowerCase().includes(qLower) || b.displayName.toLowerCase().includes(qLower))
  );

  resEl.innerHTML = '';
  if (localMatches.length) {
    const hdr = document.createElement('div');
    hdr.className = 'chat-header-sub';
    hdr.style.padding = '8px';
    hdr.textContent = 'Ваши чаты';
    resEl.appendChild(hdr);
    localMatches.forEach((conv) => resEl.appendChild(buildConvItem(conv)));
  }
  if (channelMatches.length) {
    const hdr = document.createElement('div');
    hdr.className = 'chat-header-sub';
    hdr.style.padding = '8px';
    hdr.textContent = 'Каналы (глобальный поиск)';
    resEl.appendChild(hdr);
    channelMatches.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'channel-row';
      row.innerHTML = `<div class="avatar" style="${c.avatar ? avatarStyle(c) : ''}">${c.avatar ? '' : initials(c.name)}</div><div>${escapeHtml(c.name)}${verifiedBadge(c)} 📢</div>`;
      row.addEventListener('click', async () => {
        await api(`/api/conversations/${c.id}/subscribe`, { method: 'POST' });
        await loadConversations();
        $('#chatsGlobalSearchInput').value = '';
        runChatsSearch();
        openConversation(c.id);
      });
      resEl.appendChild(row);
    });
  }
  if (botMatches.length) {
    const hdr = document.createElement('div');
    hdr.className = 'chat-header-sub';
    hdr.style.padding = '8px';
    hdr.textContent = 'Боты (глобальный поиск)';
    resEl.appendChild(hdr);
    botMatches.forEach((b) => {
      const row = document.createElement('div');
      row.className = 'channel-row';
      row.innerHTML = `<div class="avatar" style="${b.avatar ? avatarStyle(b) : ''}">${b.avatar ? '' : initials(b.displayName)}</div><div>${escapeHtml(b.displayName)}${verifiedBadge(b)} 🤖<div class="chat-header-sub">@${escapeHtml(b.username)}</div></div>`;
      row.addEventListener('click', async () => {
        const { conversation } = await api('/api/conversations', { method: 'POST', body: { type: 'dm', userId: b.id } });
        await loadConversations();
        $('#chatsGlobalSearchInput').value = '';
        runChatsSearch();
        openConversation(conversation.id);
      });
      resEl.appendChild(row);
    });
  }
  if (!localMatches.length && !channelMatches.length && !botMatches.length) {
    resEl.innerHTML = '<div class="chat-header-sub" style="padding:8px;">Ничего не найдено</div>';
  }
}
$('#chatsGlobalSearchInput').addEventListener('input', () => {
  clearTimeout(chatsSearchDebounce);
  chatsSearchDebounce = setTimeout(runChatsSearch, 200);
});

function openConvContextMenu(evt, conv) {
  const menu = $('#convContextMenu');
  const pinned = isPinned(conv);
  menu.innerHTML = `<button data-act="pin">${pinned ? '📌 Открепить' : '📌 Закрепить'}</button>`;
  menu.querySelector('[data-act="pin"]').addEventListener('click', () => {
    togglePin(conv);
    closeConvContextMenu();
  });
  $('#convContextBackdrop').classList.remove('hidden');
  menu.classList.remove('hidden');
  const x = evt.clientX || 40;
  const y = evt.clientY || 40;
  requestAnimationFrame(() => {
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
  });
}

function closeConvContextMenu() {
  $('#convContextMenu').classList.add('hidden');
  $('#convContextBackdrop').classList.add('hidden');
}
$('#convContextBackdrop').addEventListener('click', closeConvContextMenu);

/* ---------------- FOLDERS (папки чатов) ---------------- */

async function loadFolders() {
  const { folders } = await api('/api/folders');
  state.folders = folders;
  if (state.activeFolderId && !folders.find((f) => f.id === state.activeFolderId)) {
    state.activeFolderId = null;
  }
}

function renderFolderTabs() {
  const el = $('#folderTabs');
  el.innerHTML = '';
  // Если пользователь не создал ни одной своей папки — переключать нечего
  // (осталась бы только одна вкладка "Все чаты"), поэтому весь бар прячем.
  if (!state.folders.length) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  const allTab = document.createElement('button');
  allTab.className = 'folder-tab' + (state.activeFolderId ? '' : ' active');
  allTab.textContent = 'Все чаты';
  allTab.addEventListener('click', () => { state.activeFolderId = null; renderFolderTabs(); renderConvList(); });
  el.appendChild(allTab);

  state.folders.forEach((f) => {
    const tab = document.createElement('button');
    tab.className = 'folder-tab' + (state.activeFolderId === f.id ? ' active' : '');
    tab.textContent = f.name;
    tab.addEventListener('click', () => { state.activeFolderId = f.id; renderFolderTabs(); renderConvList(); });
    el.appendChild(tab);
  });
}

function renderFoldersInSettings() {
  const el = $('#foldersListSettings');
  el.innerHTML = '';
  if (!state.folders.length) {
    el.innerHTML = '<div class="chat-header-sub" style="padding:8px;">Пока нет ни одной папки</div>';
  }
  state.folders.forEach((f) => {
    const row = document.createElement('div');
    row.className = 'folder-row';
    row.innerHTML = `
      <div class="grow">
        <div class="name">🗂 ${escapeHtml(f.name)}</div>
        <div class="sub">${(f.convIds || []).length} чатов</div>
      </div>
      <button class="btn-secondary" data-open-folder="${f.id}">Изменить</button>
    `;
    el.appendChild(row);
  });
  el.querySelectorAll('[data-open-folder]').forEach((btn) => {
    btn.addEventListener('click', () => openFolderEditModal(btn.dataset.openFolder));
  });
}

$('#createFolderBtn').addEventListener('click', () => {
  openFolderEditModal(null);
});

/* ---------------- НАСТРОЙКИ: устройства (сессии) ---------------- */

// "Сегодня в 14:32" / "Вчера в 09:10" / "12 августа в 20:01" — для времени
// последней активности сеанса. Переиспользует те же подписи дат, что и
// разделители дней в переписке, чтобы не заводить отдельный форматтер.
function fmtLastSeen(ts) {
  if (!ts) return '';
  return `${dateSeparatorLabel(ts)} в ${fmtTime(ts)}`;
}

async function renderDevicesInSettings() {
  const currentEl = $('#currentDeviceRow');
  const listEl = $('#otherDevicesList');
  const emptyHint = $('#devicesEmptyHint');
  const revokeAllBtn = $('#revokeOtherSessionsBtn');
  const errEl = $('#devicesError');
  errEl.textContent = '';
  currentEl.innerHTML = '<div class="grow"><div class="name">Загрузка…</div></div>';
  listEl.innerHTML = '';
  emptyHint.classList.add('hidden');
  revokeAllBtn.classList.add('hidden');

  let sessions;
  try {
    ({ sessions } = await api('/api/sessions'));
  } catch (e) {
    currentEl.innerHTML = '';
    errEl.textContent = e.message || 'Не удалось загрузить список устройств';
    return;
  }

  const current = sessions.find((s) => s.current);
  const others = sessions.filter((s) => !s.current);

  currentEl.innerHTML = current
    ? `<div class="grow"><div class="name">${escapeHtml(current.device)}</div><div class="sub">Сейчас в сети${current.ip ? ' · ' + escapeHtml(current.ip) : ''}</div></div>`
    : '<div class="grow"><div class="name">Этот браузер</div><div class="sub">Сейчас в сети</div></div>';

  if (!others.length) {
    emptyHint.classList.remove('hidden');
  } else {
    revokeAllBtn.classList.remove('hidden');
    others.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'folder-row';
      row.innerHTML = `
        <div class="grow">
          <div class="name">${escapeHtml(s.device)}</div>
          <div class="sub">Был(а) в сети: ${escapeHtml(fmtLastSeen(s.lastSeenAt))}${s.ip ? ' · ' + escapeHtml(s.ip) : ''}</div>
        </div>
        <button class="btn-secondary" data-revoke-session="${s.id}">Завершить</button>
      `;
      listEl.appendChild(row);
    });
    listEl.querySelectorAll('[data-revoke-session]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = '…';
        try {
          await api('/api/sessions/' + encodeURIComponent(btn.dataset.revokeSession), { method: 'DELETE' });
          renderDevicesInSettings();
        } catch (e) {
          errEl.textContent = e.message || 'Не удалось завершить сеанс';
          btn.disabled = false;
          btn.textContent = 'Завершить';
        }
      });
    });
  }
}

$('#revokeOtherSessionsBtn').addEventListener('click', async () => {
  const btn = $('#revokeOtherSessionsBtn');
  btn.disabled = true;
  const prevText = btn.textContent;
  btn.textContent = 'Завершаем…';
  try {
    await api('/api/sessions/revoke-others', { method: 'POST' });
    renderDevicesInSettings();
  } catch (e) {
    $('#devicesError').textContent = e.message || 'Не удалось завершить сеансы';
  } finally {
    btn.disabled = false;
    btn.textContent = prevText;
  }
});

$('#confirmQrCodeBtn').addEventListener('click', async () => {
  const raw = (prompt('Введите код с другого устройства (или вставьте всю ссылку из-под QR-кода):') || '').trim();
  if (!raw) return;
  // Если вставили целую ссылку вида https://.../qr/<id> — вытаскиваем сам id,
  // иначе считаем, что ввели id как есть.
  const linkMatch = raw.match(/\/qr\/([^/?#\s]+)/);
  const ticketId = linkMatch ? linkMatch[1] : raw;
  $('#devicesError').textContent = '';
  try {
    await api(`/api/qr-login/${encodeURIComponent(ticketId)}/confirm`, { method: 'POST' });
    alert('Готово — другое устройство сейчас войдёт в аккаунт автоматически.');
  } catch (e) {
    $('#devicesError').textContent = e.message || 'Код недействителен или уже устарел';
  }
});

let editingFolderId = null;
function openFolderEditModal(folderId) {
  editingFolderId = folderId;
  const folder = folderId ? state.folders.find((f) => f.id === folderId) : null;
  $('#folderNameInput').value = folder ? folder.name : '';
  $('#deleteFolderBtn').classList.toggle('hidden', !folder);
  const checklist = $('#folderConvChecklist');
  checklist.innerHTML = '';
  const selectedIds = new Set(folder ? (folder.convIds || []) : []);
  state.conversations.forEach((conv) => {
    const row = document.createElement('div');
    row.className = 'folder-conv-check-row';
    const title = convTitle(conv);
    const favSubject = conv.type === 'dm' ? conv.peer : conv;
    const favUrl = favSubject && favSubject.avatar;
    row.innerHTML = `<label><input type="checkbox" value="${conv.id}" ${selectedIds.has(conv.id) ? 'checked' : ''}><span class="avatar" style="width:28px;height:28px;font-size:12px;${favUrl ? avatarStyle(favSubject) : ''}">${favUrl ? '' : initials(title)}</span>${escapeHtml(title)}</label>`;
    checklist.appendChild(row);
  });
  showModal('#folderEditModal');
}

$('#saveFolderBtn').addEventListener('click', async () => {
  const name = $('#folderNameInput').value.trim();
  if (!name) { alert('Укажите название папки'); return; }
  const convIds = $all('#folderConvChecklist input[type=checkbox]:checked').map((c) => c.value);
  try {
    if (editingFolderId) {
      await api(`/api/folders/${editingFolderId}`, { method: 'PATCH', body: { name, convIds } });
    } else {
      await api('/api/folders', { method: 'POST', body: { name, convIds } });
    }
    $('#folderEditModal').classList.add('hidden');
    await loadFolders();
    renderFolderTabs();
    renderConvList();
    renderFoldersInSettings();
  } catch (err) { alert(err.message); }
});

$('#deleteFolderBtn').addEventListener('click', async () => {
  if (!editingFolderId) return;
  if (!confirm('Удалить эту папку? Сами чаты при этом не удаляются.')) return;
  try {
    await api(`/api/folders/${editingFolderId}`, { method: 'DELETE' });
    $('#folderEditModal').classList.add('hidden');
    if (state.activeFolderId === editingFolderId) state.activeFolderId = null;
    await loadFolders();
    renderFolderTabs();
    renderConvList();
    renderFoldersInSettings();
  } catch (err) { alert(err.message); }
});

function previewText(m) {
  const map = { text: stripMessageFormatting(m.content), image: '📷 Фото', video: '🎬 Видео', file: '📄 Файл', music: '🎵 Музыка', voice: '🎙 Голосовое', video_circle: '⭕ Видео-сообщение', sticker: '😊 Стикер', poll: '📊 Опрос', location: '📍 Геолокация', album: '🖼 Альбом' };
  const base = map[m.msgType] || stripMessageFormatting(m.content) || '';
  return m.forwardFrom ? `↪️ ${base}` : base;
}

// Сообщает нативному Android-сервису уведомлений (AsteriaPushService),
// какой именно чат сейчас открыт — точно то же условие, что и
// isViewingThisChat в notifyNewMessage() ниже. Сервис хранит эти два
// значения и не показывает уведомление о новом сообщении, если оно как раз
// из открытого сейчас чата (даже если приложение свёрнуто в фоне, но
// процесс ещё жив). Если моста нет (обычный браузер) — просто ничего не
// делает.
function reportActiveChatToNative() {
  if (window.AsteriaNotify && typeof window.AsteriaNotify.setActiveConversation === 'function') {
    try { window.AsteriaNotify.setActiveConversation(state.activeSection === 'chats' ? (state.activeConvId || '') : ''); } catch (e) { /* игнорируем */ }
  }
}

async function openConversation(convId) {
  state.activeConvId = convId;
  reportActiveChatToNative();
  $('#chatEmpty').classList.add('hidden');
  $('#chatActive').classList.remove('hidden');
  if (isMobile()) {
    $('#sectionChats').classList.add('chat-open');
    $('#appScreen').classList.add('chat-open');
  }
  renderConvList();
  const conv = state.conversations.find((c) => c.id === convId);
  renderChatHeader(conv);
  updateComposerVisibility(conv);
  if (!state.messagesLoaded[convId]) {
    // Открытие чата подгружает только "хвост" переписки (последние 40
    // сообщений), а не всю историю целиком — раньше именно полная выгрузка
    // (плюс мгновенный автозапуск всех видео-превью в ней) была причиной
    // долгой (до нескольких секунд, особенно на слабом сервере) загрузки
    // при открытии чатов с большой историей. Более старые сообщения
    // подгружаются лениво по мере прокрутки вверх — см. слушатель scroll
    // на #messages и loadOlderMessages() ниже.
    const msgResp = await api(`/api/conversations/${convId}/messages?limit=${MESSAGES_PAGE_SIZE}`);
    const { messages, hasMore } = msgResp;
    // Без сети сюда пришла копия с телефона: историю потом дозагрузим (см. resyncAfterReconnect)
    const fromOfflineCopy = !!msgResp.__offline;
    // Если по WS уже успело прилететь сообщение в этот (ещё не открытый)
    // чат (см. комментарий у state.messagesLoaded выше), не выбрасываем
    // его — сливаем с загруженной историей, отбрасывая дубликаты по id и
    // восстанавливая хронологический порядок.
    const already = state.messages[convId] || [];
    const byId = new Map(messages.map((m) => [m.id, m]));
    // AirPin: локальная копия сообщения, дошедшего через mesh, заменяется серверной
    const serverAirIds = new Set(messages.map((m) => m.meta && m.meta.airpinId).filter(Boolean));
    already.forEach((m) => {
      if (m.meta && m.meta.airpinId && serverAirIds.has(m.meta.airpinId) && String(m.id).startsWith('airpin:')) return;
      if (!byId.has(m.id)) byId.set(m.id, m);
    });
    state.messages[convId] = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
    state.messagesHasMore[convId] = fromOfflineCopy ? true : !!hasMore;
    state.messagesLoaded[convId] = !fromOfflineCopy;
  }
  renderMessages();
  markConversationRead(convId);
  updateNativeSystemBars();
}

// Отправляет отметку «прочитано» по WebSocket и сразу же локально обнуляет
// бейдж непрочитанных в списке чатов, не дожидаясь ответа сервера.
function markConversationRead(convId) {
  const conv = state.conversations.find((c) => c.id === convId);
  if (conv && conv.unreadCount) { conv.unreadCount = 0; renderConvList(); }
  if (state.ws && state.ws.readyState === 1) {
    state.ws.send(JSON.stringify({ type: 'read', conversationId: convId }));
  }
}

function closeActiveChat() {
  state.activeConvId = null;
  reportActiveChatToNative();
  $('#chatEmpty').classList.remove('hidden');
  $('#chatActive').classList.add('hidden');
  $('#sectionChats').classList.remove('chat-open');
  $('#appScreen').classList.remove('chat-open');
  renderConvList();
  moveBottomNavIndicator(state.activeSection || 'chats', false);
  updateNativeSystemBars();
}

$('#backToListBtn').addEventListener('click', () => {
  $('#sectionChats').classList.remove('chat-open');
  $('#appScreen').classList.remove('chat-open');
  moveBottomNavIndicator(state.activeSection || 'chats', false);
  updateNativeSystemBars();
});

function canPostInConv(conv) {
  if (!conv) return false;
  if (conv.type === 'dm' || conv.type === 'group') return true;
  return convPerm(conv, 'post');
}
function isSubscribedTo(conv) {
  if (!conv || (conv.type !== 'channel' && conv.type !== 'group')) return true;
  return (conv.participants || []).includes(state.user.id);
}

function updateComposerVisibility(conv) {
  const showChannelBar = conv && conv.type === 'channel' && isSubscribedTo(conv) && !canPostInConv(conv);
  const showBotStartBar = !!(conv && conv.type === 'dm' && conv.peer && conv.peer.isBot
    && (state.messages[conv.id] || []).length === 0);
  $('#composer').classList.toggle('hidden', showChannelBar || showBotStartBar);
  $('#channelSubscribedBar').classList.toggle('hidden', !showChannelBar);
  $('#botStartBar').classList.toggle('hidden', !showBotStartBar);
  updateSendOrRecordButton();
  autoGrowMessageInput();
}

$('#botStartBtn').addEventListener('click', async () => {
  if (!state.activeConvId) return;
  $('#botStartBtn').disabled = true;
  try {
    sendWSMessage('text', '/start', null, null);
  } finally {
    $('#botStartBtn').disabled = false;
  }
});

$('#unsubscribeFromBarBtn').addEventListener('click', async () => {
  if (!state.activeConvId) return;
  if (!confirm('Отписаться от этого канала?')) return;
  await api(`/api/conversations/${state.activeConvId}/unsubscribe`, { method: 'POST' });
  state.conversations = state.conversations.filter((c) => c.id !== state.activeConvId);
  closeActiveChat();
});

function renderChatHeader(conv) {
  const title = convTitle(conv);
  const sub = conv.type === 'channel' ? `${(conv.participants||[]).length} подписчиков` : conv.type === 'group' ? `${(conv.participants||[]).length} участников` : (conv.peer && conv.peer.online ? 'в сети' : (conv.peer && conv.peer.isBot ? 'бот' : 'не в сети'));
  const badge = conv.type === 'dm' ? verifiedBadge(conv.peer) : verifiedBadge(conv) + rknBadge(conv);
  const headerAvatarSubject = conv.type === 'dm' ? conv.peer : conv;
  const headerAvatarUrl = headerAvatarSubject && headerAvatarSubject.avatar;
  $('#chatHeaderInfo').innerHTML = `<div class="avatar${avatarRingClass(conv.type === 'dm' ? conv.peer : null)}" style="${headerAvatarUrl ? avatarStyle(headerAvatarSubject) : ''}">${headerAvatarUrl ? '' : initials(title)}</div><div><div class="chat-header-name">${escapeHtml(title)}${badge}</div><div class="chat-header-sub">${escapeHtml(sub)}</div></div>`;
  renderPinnedBar(conv);
  const canCall = conv.type === 'dm' && conv.peer && !conv.peer.isBot;
  $('#audioCallBtn').style.display = canCall ? '' : 'none';
  $('#videoCallBtn').style.display = canCall ? '' : 'none';
  updateGroupCallButton(conv);
}

$('#chatHeaderInfo').addEventListener('click', () => {
  const conv = state.conversations.find((c) => c.id === state.activeConvId);
  if (!conv) return;
  if (conv.type === 'dm') openProfilePage(conv.peer.id);
  else openChannelPage(conv.id);
});

// Кто может закреплять/откреплять сообщения в этом чате: в личных чатах —
// любой участник, в каналах — только владелец канала или админ сайта.
function canPinInConversation(conv) {
  if (!conv) return false;
  if (conv.type === 'dm' || conv.type === 'group') return true;
  if (conv.type === 'channel') return convPerm(conv, 'pin');
  return false;
}

function renderPinnedBar(conv) {
  const bar = $('#pinnedMessageBar');
  const pinned = conv.pinnedMessage;
  if (!pinned) {
    bar.classList.add('hidden');
    bar.onclick = null;
    return;
  }
  bar.classList.remove('hidden');
  const senderName = pinned.senderId === state.user.id ? 'Вы' : (findKnownUser(pinned.senderId) || {}).displayName || 'Сообщение';
  $('#pinnedMessageText').innerHTML = `<b>${escapeHtml(senderName)}:</b> ${escapeHtml(previewText(pinned))}`;
  $('#unpinMessageBtn').classList.toggle('hidden', !canPinInConversation(conv));
  bar.onclick = (e) => {
    if (e.target.closest('#unpinMessageBtn')) return;
    scrollToMessage(pinned.id);
  };
}

$('#unpinMessageBtn').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!state.activeConvId) return;
  await togglePinMessage(state.activeConvId, null);
});

async function togglePinMessage(conversationId, messageId) {
  try {
    const { conversation } = await api(`/api/conversations/${conversationId}/pin-message`, { method: 'POST', body: { messageId } });
    const idx = state.conversations.findIndex((c) => c.id === conversationId);
    if (idx !== -1) state.conversations[idx] = { ...state.conversations[idx], pinnedMessage: conversation.pinnedMessage, pinnedMessageId: conversation.pinnedMessageId };
    if (state.activeConvId === conversationId) renderPinnedBar(state.conversations[idx] || conversation);
  } catch (e) { alert(e.message); }
}

// Сама прокрутка к сообщению — функция scrollToMessage(), определённая
// ниже, там же, где остальные хелперы для работы с постранично
// подгружаемой историей чата (её видно и здесь благодаря hoisting).

/* ---------------- PROFILE PAGE ---------------- */

// ----- Общие кирпичики «стеклянного» профиля (человек, канал, группа) -----
// Раскладка по макету дизайнеров: плавающие стеклянные кнопки сверху, большой
// аватар и имя, ряд круглых действий, карточка с данными, сегмент
// «Медиа / Файлы / Ссылки / Аудио» и крупные кнопки внизу.
const PF_ICONS = {
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.5-4.6A8 8 0 1 1 21 12z"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
  video: '<rect x="2" y="6" width="13" height="12" rx="3"/><path d="M15 10.5l6-3.5v10l-6-3.5z"/>',
  share: '<path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M5 12v6a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="3"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h3v3M21 14v1M14 21h3M21 18v3h-2"/>',
};
function pfIcon(name, size) {
  const px = size || 22;
  return `<svg viewBox="0 0 24 24" width="${px}" height="${px}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PF_ICONS[name] || ''}</svg>`;
}
// items: [{ attr: 'data-pf' | 'data-act', act, icon, label }]
function pfActionsHtml(items) {
  if (!items.length) return '';
  return `<div class="pf-actions">${items.map((it, n) =>
    `<button type="button" class="pf-action" style="--n:${n}" ${it.attr}="${it.act}" aria-label="${escapeHtml(it.label)}" title="${escapeHtml(it.label)}">${pfIcon(it.icon)}</button>`
  ).join('')}</div>`;
}
function ruPlural(n, forms) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

async function openDmWith(userId) {
  const { conversation } = await api('/api/conversations', { method: 'POST', body: { type: 'dm', userId } });
  await loadConversations();
  switchSection('chats');
  await openConversation(conversation.id);
}

// История чата очищена (мной или собеседником): сбрасываем всё, что клиент
// успел закешировать про этот чат, и перерисовываем открытый чат/список.
function applyHistoryCleared(convId) {
  state.messages[convId] = [];
  state.messagesLoaded[convId] = true; // пустая история — это и есть актуальное состояние
  state.messagesHasMore[convId] = false;
  const idx = state.conversations.findIndex((c) => c.id === convId);
  if (idx !== -1) {
    state.conversations[idx] = {
      ...state.conversations[idx],
      lastMessage: null, lastMessageAt: 0, unreadCount: 0, unread: 0,
      pinnedMessage: null, pinnedMessageId: null, reads: {},
    };
    if (state.activeConvId === convId) renderPinnedBar(state.conversations[idx]);
  }
  if (state.activeConvId === convId) renderMessages();
  renderConvList();
}

async function openProfilePage(userId) {
  const { user } = await api(`/api/users/${userId}`);
  const el = $('#profileViewContent');
  const isOwnProfile = user.id === state.user.id;
  const canContact = !isOwnProfile && !user.isBot;
  const shownName = user.contactNickname || user.displayName;

  const actions = [];
  if (!isOwnProfile) actions.push({ attr: 'data-pf', act: 'chat', icon: 'chat', label: 'Написать' });
  if (canContact) {
    actions.push({ attr: 'data-pf', act: 'call', icon: 'phone', label: 'Позвонить' });
    actions.push({ attr: 'data-pf', act: 'video', icon: 'video', label: 'Видеозвонок' });
  }
  if (!user.isBot) actions.push({ attr: 'data-pf', act: 'share', icon: 'share', label: 'Поделиться профилем' });

  // Есть активная история — вокруг аватара кольцо, тап открывает историю прямо из профиля.
  const profileStoryGroup = (state.storyGroups || []).find((g) => g.user && g.user.id === user.id && g.stories && g.stories.length) || null;
  el.innerHTML = `
    <div class="pf">
      <div class="pf-hero">
        <div class="pf-avatar-wrap${profileStoryGroup ? ' has-story' : ''}${profileStoryGroup && storyGroupSeen(profileStoryGroup.stories) ? ' seen' : ''}"><div class="my-avatar big xl pf-avatar${avatarRingClass(user)}" style="${avatarStyle(user)}">${user.avatar ? '' : initials(user.displayName)}</div></div>
        <div class="pf-name">${escapeHtml(shownName)}${verifiedBadge(user)}${user.isBot ? ' 🤖' : ''}</div>
        <div class="pf-handle">@${escapeHtml(user.username)}</div>
      </div>
      ${pfActionsHtml(actions)}
      <div class="settings-list-group settings-info-group pf-card">
        <div class="settings-info-row">
          <div class="grow">
            <div class="sir-label">имя пользователя</div>
            <div class="sir-value">@${escapeHtml(user.username)}</div>
          </div>
          ${!user.isBot ? `<button type="button" class="pf-mini-btn" data-pf="share" title="Показать QR-код" aria-label="Показать QR-код">${pfIcon('qr', 18)}</button>` : ''}
        </div>
        ${user.status ? `
        <div class="settings-info-row">
          <div class="grow">
            <div class="sir-label">о себе</div>
            <div class="sir-value">${escapeHtml(user.status)}</div>
          </div>
        </div>` : ''}
        <div class="settings-info-row">
          <div class="grow">
            <div class="sir-label">${user.online ? 'статус' : 'на платформе с'}</div>
            <div class="sir-value">${user.online ? 'в сети' : fmtDate(user.createdAt)}</div>
          </div>
        </div>
        ${user.encryptionKeyFingerprint ? `
        <div class="settings-info-row">
          <div class="grow">
            <div class="sir-label">ключ шифрования переписки</div>
            <div class="sir-value encryption-key-value">${escapeHtml(user.encryptionKeyFingerprint)}</div>
            <div class="sir-hint">Уникален для этой переписки. Совпадает у вас и у собеседника — если он вдруг изменится, значит переписка идёт уже не с тем же диалогом.</div>
          </div>
        </div>` : ''}
      </div>
      ${!user.isBot ? '<div class="pf-media" id="profileMediaSection"></div>' : ''}
      ${canContact ? `<div class="pf-cta">
        ${!user.isContact ? '<button type="button" class="pf-cta-btn pf-cta-blue" data-pf="add-contact">Добавить в контакты</button>' : ''}
        ${user.isBlocked
          ? '<button type="button" class="pf-cta-btn pf-cta-quiet" data-pf="unblock">Разблокировать</button>'
          : '<button type="button" class="pf-cta-btn pf-cta-red" data-pf="block">Заблокировать</button>'}
        <button type="button" class="pf-cta-btn pf-cta-red" data-pf="clear-history">Очистить историю у обоих</button>
      </div>` : ''}
    </div>
  `;
  switchSection('profile');

  // Кнопка «Изм.» справа сверху: у контакта — локальное имя, у своего
  // профиля — переход к редактированию в настройках.
  const editBtn = $('#editContactNicknameBtn');
  if (editBtn) {
    const showEdit = isOwnProfile || (canContact && user.isContact);
    editBtn.classList.toggle('hidden', !showEdit);
    editBtn.onclick = !showEdit ? null : () => {
      if (isOwnProfile) { switchSection('settings'); openSettingsSubpage('profile'); }
      else openContactNicknameModal(user);
    };
  }

  const heroAvatar = el.querySelector('.pf-avatar');
  if (heroAvatar && profileStoryGroup) {
    // Тап — смотреть историю, долгое нажатие — открыть фото профиля.
    heroAvatar.classList.add('avatar-clickable');
    heroAvatar.title = 'Смотреть историю';
    attachLongPress(heroAvatar,
      () => { if (user.avatar) openAvatarLightbox(user.avatar); },
      () => viewStories(profileStoryGroup.stories, user, el.querySelector('.pf-avatar-wrap')));
  } else if (heroAvatar && user.avatar) {
    heroAvatar.classList.add('avatar-clickable');
    heroAvatar.title = 'Открыть фото профиля';
    heroAvatar.addEventListener('click', () => openAvatarLightbox(user.avatar));
  }

  el.onclick = async (e) => {
    const btn = e.target.closest('[data-pf]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.pf;
    try {
      if (act === 'chat') {
        await openDmWith(user.id);
      } else if (act === 'call' || act === 'video') {
        if (user.isBlocked) { alert('Вы заблокировали этого пользователя. Разблокируйте его, чтобы позвонить.'); return; }
        await redialUser(user.id, act === 'video' ? 'video' : 'audio');
      } else if (act === 'share') {
        openShareModal(user.displayName, buildProfileLink(user.username));
      } else if (act === 'add-contact') {
        btn.disabled = true;
        btn.textContent = 'Добавляю…';
        try {
          // Локальное имя сразу равно текущему видимому имени — у контакта
          // всегда есть конкретная отправная точка для «Изм.».
          await api('/api/contacts', { method: 'POST', body: { userId: user.id, nickname: user.displayName } });
          await openProfilePage(user.id);
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Добавить в контакты';
          alert(err.message || 'Не удалось добавить в контакты');
        }
      } else if (act === 'block') {
        if (!confirm(`Заблокировать «${shownName}»? Вы не сможете писать и звонить друг другу, пока не разблокируете.`)) return;
        await api('/api/blocks', { method: 'POST', body: { userId: user.id } });
        await openProfilePage(user.id);
        loadConversations();
      } else if (act === 'unblock') {
        await api(`/api/blocks/${user.id}`, { method: 'DELETE' });
        await openProfilePage(user.id);
        loadConversations();
      } else if (act === 'clear-history') {
        if (!confirm(`Очистить всю историю переписки с «${shownName}»?\n\nВсе сообщения и файлы будут безвозвратно удалены у вас обоих, а файлы — стёрты с сервера. Отменить это нельзя.`)) return;
        btn.disabled = true;
        const oldLabel = btn.textContent;
        btn.textContent = 'Очищаю…';
        try {
          const { conversation } = await api('/api/conversations', { method: 'POST', body: { type: 'dm', userId: user.id } });
          const r = await api(`/api/conversations/${conversation.id}/history`, { method: 'DELETE' });
          applyHistoryCleared(conversation.id);
          await openProfilePage(user.id);
          alert(`История очищена: сообщений — ${r.removedMessages || 0}, файлов — ${r.removedFiles || 0}.`);
        } finally {
          btn.disabled = false;
          btn.textContent = oldLabel;
        }
      }
    } catch (err) {
      alert(err.message || 'Не удалось выполнить действие');
    }
  };

  if (!user.isBot) {
    mountProfileMedia($('#profileMediaSection'), async () => {
      const { conversation } = await api('/api/conversations', { method: 'POST', body: { type: 'dm', userId: user.id } });
      return collectProfileMedia(await fetchAllMessagesForProfileMedia(conversation.id));
    });
  }
}

// ---------- Локальное имя контакта ----------
function openContactNicknameModal(user) {
  // Отправная точка для редактирования — уже заданное локальное имя, а
  // если его почему-то нет (старые записи и т.п.) — текущее видимое имя
  // человека, а не пустое поле без контекста.
  $('#contactNicknameInput').value = user.contactNickname || user.displayName || '';
  $('#contactNicknameInput').dataset.userId = user.id;
  showModal('#contactNicknameModal');
}
$('#saveContactNicknameBtn').addEventListener('click', async () => {
  const userId = $('#contactNicknameInput').dataset.userId;
  const nickname = $('#contactNicknameInput').value.trim();
  if (!userId) return;
  try {
    await api(`/api/contacts/${userId}`, { method: 'PATCH', body: { nickname } });
    $('#contactNicknameModal').classList.add('hidden');
    await openProfilePage(userId);
    await loadConversations(); // чтобы новое имя сразу подхватилось в списке чатов
  } catch (e) {
    alert(e.message || 'Не удалось сохранить');
  }
});
$('#removeContactBtn').addEventListener('click', async () => {
  const userId = $('#contactNicknameInput').dataset.userId;
  if (!userId) return;
  if (!confirm('Убрать этого человека из контактов? Переписка и история звонков останутся.')) return;
  try {
    await api(`/api/contacts/${userId}`, { method: 'DELETE' });
    $('#contactNicknameModal').classList.add('hidden');
    await openProfilePage(userId);
    await loadConversations();
  } catch (e) {
    alert(e.message || 'Не удалось убрать из контактов');
  }
});

// Общие медиа/файлы/ссылки/аудио — вкладки внизу профиля (человека, канала,
// группы). Сборка данных — collectProfileMedia, отрисовка — mountProfileMedia.

// Постранично тянем всю историю переписки с этим человеком (а не только
// то, что уже подгружено в открытом чате — профиль может быть открыт и
// без захода в сам чат). Ограничиваем разумным потолком, чтобы не
// утащить в память тысячи сообщений у очень старых переписок.
const PROFILE_MEDIA_FETCH_CAP = 400;
async function fetchAllMessagesForProfileMedia(convId) {
  let before = null;
  let all = [];
  try {
    while (all.length < PROFILE_MEDIA_FETCH_CAP) {
      const { messages, hasMore } = await api(`/api/conversations/${convId}/messages?limit=100${before ? '&before=' + before : ''}`);
      if (!messages.length) break;
      all = messages.concat(all);
      if (!hasMore) break;
      before = messages[0].createdAt;
    }
  } catch (e) {
    // тихо игнорируем — просто покажем то, что успели собрать
  }
  return all;
}

const PROFILE_MEDIA_TABS = [
  { key: 'media', label: 'Медиа', empty: 'Пока нет фото и видео' },
  { key: 'files', label: 'Файлы', empty: 'Пока нет файлов' },
  { key: 'links', label: 'Ссылки', empty: 'Пока нет ссылок' },
  { key: 'audio', label: 'Аудио', empty: 'Пока нет аудио' },
];

function collectProfileMedia(messages) {
  const data = { media: [], files: [], links: [], audio: [] };
  const linkRe = /(https?:\/\/[^\s<>"']{4,600})/g;
  messages.forEach((m) => {
    if (m.msgType === 'image' || m.msgType === 'video') {
      data.media.push({ url: m.mediaUrl, type: m.msgType, createdAt: m.createdAt });
    } else if (m.msgType === 'album' && m.meta && Array.isArray(m.meta.items)) {
      m.meta.items.forEach((it) => data.media.push({ url: it.url, type: it.kind === 'video' ? 'video' : 'image', createdAt: m.createdAt }));
    } else if (m.msgType === 'file') {
      data.files.push({ url: m.mediaUrl, name: (m.meta && m.meta.name) || 'Файл', createdAt: m.createdAt });
    } else if (m.msgType === 'voice') {
      data.audio.push({ url: m.mediaUrl, name: 'Голосовое сообщение', icon: '🎙', createdAt: m.createdAt });
    } else if (m.msgType === 'music') {
      data.audio.push({ url: m.mediaUrl, name: (m.meta && m.meta.name) || 'Трек', icon: '🎵', createdAt: m.createdAt });
    }
    if (m.msgType === 'text' && m.content) {
      const found = m.content.match(linkRe);
      if (found) found.forEach((url) => data.links.push({ url, createdAt: m.createdAt }));
    }
  });
  Object.keys(data).forEach((k) => data[k].sort((a, b) => b.createdAt - a.createdAt));
  return data;
}

// Стеклянный сегмент вкладок + карточка с содержимым. Сегмент строится один
// раз (чтобы «таблетка» выбора плавно переезжала между вкладками), меняется
// только содержимое карточки. fetchData — async-функция, возвращающая
// результат collectProfileMedia.
function mountProfileMedia(section, fetchData) {
  if (!section) return;
  let data = null;
  let active = 'media';
  section.innerHTML = `
    <div class="pf-seg" role="tablist" style="--i:0">
      <span class="pf-seg-pill"></span>
      ${PROFILE_MEDIA_TABS.map((t) => `<button type="button" role="tab" class="pf-seg-tab${t.key === active ? ' active' : ''}" data-tab="${t.key}">${t.label}</button>`).join('')}
    </div>
    <div class="pf-card pf-media-card"></div>`;
  const seg = section.querySelector('.pf-seg');
  const body = section.querySelector('.pf-media-card');

  function drawBody() {
    const tab = PROFILE_MEDIA_TABS.find((t) => t.key === active);
    if (!data) { body.innerHTML = '<div class="pf-empty">Загрузка…</div>'; return; }
    const list = data[active];
    if (!list.length) { body.innerHTML = `<div class="pf-empty">${tab.empty}</div>`; return; }
    if (active === 'media') {
      body.innerHTML = `<div class="profile-media-grid">${list.map((it, idx) =>
        `<div class="profile-media-tile" data-idx="${idx}" data-type="${it.type}">
          ${it.type === 'video' ? `<video src="${it.url}" muted playsinline preload="metadata"></video><span class="album-video-badge">▶</span>` : `<img src="${it.url}" loading="lazy">`}
        </div>`).join('')}</div>`;
      body.querySelectorAll('.profile-media-tile').forEach((tile) => {
        tile.addEventListener('click', () => openProfileMediaLightbox(list, Number(tile.dataset.idx)));
      });
    } else if (active === 'files') {
      body.innerHTML = `<div class="profile-files-list">${list.map((f) =>
        `<a class="profile-file-row" href="${escapeHtml(uploadDownloadHref(f.url, sanitizeFilename(f.name) || 'file'))}" download="${escapeHtml(sanitizeFilename(f.name) || 'file')}" rel="noopener noreferrer">
          <span class="profile-file-icon">📄</span>
          <span class="grow"><span class="profile-file-name">${escapeHtml(f.name)}</span><span class="profile-file-date">${fmtDate(f.createdAt)}</span></span>
        </a>`).join('')}</div>`;
    } else if (active === 'links') {
      body.innerHTML = `<div class="profile-links-list">${list.map((l) =>
        `<a class="profile-link-row" href="${l.url}" target="_blank" rel="noopener noreferrer nofollow">
          <span class="profile-file-icon">🔗</span>
          <span class="grow"><span class="profile-link-url">${escapeHtml(l.url)}</span><span class="profile-file-date">${fmtDate(l.createdAt)}</span></span>
        </a>`).join('')}</div>`;
    } else {
      body.innerHTML = `<div class="profile-files-list">${list.map((a) =>
        `<div class="profile-file-row pf-audio-row">
          <span class="profile-file-icon">${a.icon}</span>
          <span class="grow"><span class="profile-file-name">${escapeHtml(a.name)}</span><span class="profile-file-date">${fmtDate(a.createdAt)}</span>
          <audio controls preload="none" src="${a.url}"></audio></span>
        </div>`).join('')}</div>`;
    }
  }

  seg.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('.pf-seg-tab');
    if (!tabBtn || tabBtn.dataset.tab === active) return;
    active = tabBtn.dataset.tab;
    seg.style.setProperty('--i', String(PROFILE_MEDIA_TABS.findIndex((t) => t.key === active)));
    seg.querySelectorAll('.pf-seg-tab').forEach((b) => b.classList.toggle('active', b === tabBtn));
    drawBody();
  });

  drawBody();
  Promise.resolve().then(fetchData).catch(() => ({ media: [], files: [], links: [], audio: [] })).then((d) => {
    // человек мог уйти на другой профиль, пока грузилась история
    if (!document.body.contains(section)) return;
    data = d;
    drawBody();
  });
}

// Отдельный от обычного лайтбокса чата список (см. openLightbox выше) —
// здесь листаем именно общие медиа с этим человеком, а не сообщения
// текущего открытого чата (профиль можно открыть, даже не заходя в чат).
function openProfileMediaLightbox(media, startIdx) {
  lightboxState.list = media.map((it) => ({ url: it.url, type: it.type, msgId: null, itemIdx: null }));
  showLightboxAt(startIdx);
}

/* ---------------- CHANNEL PAGE ---------------- */

// Страница канала/группы устроена как «Настройки»: на главном экране —
// обычный профиль (аватар, описание, ссылка, подписка), а у владельца и
// администраторов в шапке появляется кнопка «⋯», открывающая список разделов
// управления (основное, ссылка, реакции, администраторы, удаление). Каждый
// пункт — отдельный экран; «Назад» поднимается на уровень выше.

const CHANNEL_PERMS = [
  { key: 'post', label: 'Публиковать посты', onlyChannel: true },
  { key: 'editInfo', label: 'Менять название и описание' },
  { key: 'editPhoto', label: 'Менять фото' },
  { key: 'pin', label: 'Закреплять сообщения' },
  { key: 'deleteMessages', label: 'Удалять чужие сообщения' },
  { key: 'manageLink', label: 'Менять пригласительную ссылку' },
  { key: 'manageReactions', label: 'Управлять реакциями' },
  { key: 'addAdmins', label: 'Назначать администраторов' },
];
const CHANNEL_DEFAULT_PERMS = { post: true, pin: true, deleteMessages: true };

const channelNav = {
  convId: null,
  view: 'profile', // profile | manage | edit | link | reactions | admins | adminPick | adminEdit
  avatarUrl: '',
  members: null,
  membersError: '',
  pickList: null,
  pickQuery: '',
  target: null,
  targetIsNew: false,
  reactionMode: 'all',
  reactionSel: [],
};

// Есть ли у меня право perm в этом канале/группе: владелец и админ сайта —
// всегда, администратор чата — если право явно выдано.
function convPerm(conv, perm) {
  if (!conv || (conv.type !== 'channel' && conv.type !== 'group')) return false;
  if (conv.ownerId === state.user.id || state.user.isAdmin) return true;
  const entry = conv.admins && conv.admins[state.user.id];
  return !!(entry && entry.perms && entry.perms[perm] === true);
}
function convFullAccess(conv) {
  return !!conv && (conv.ownerId === state.user.id || !!state.user.isAdmin);
}
function channelConv() {
  return state.conversations.find((c) => c.id === channelNav.convId) || null;
}

// Разделы управления, доступные мне (по правам). Пустой список — кнопка «⋯»
// не показывается (например, у админа только с правом публиковать посты).
function channelManageRows(conv) {
  const rows = [];
  const isGroup = conv.type === 'group';
  if (convPerm(conv, 'editInfo') || convPerm(conv, 'editPhoto')) {
    rows.push({ group: 1, act: 'go-edit', icon: '🖼', color: 'blue', label: isGroup ? 'Фото, название и описание' : 'Фото, название и описание' });
  }
  if (convPerm(conv, 'manageLink')) {
    rows.push({ group: 2, act: 'go-link', icon: '🔗', color: 'teal', label: 'Пригласительная ссылка' });
  }
  if (convPerm(conv, 'manageReactions')) {
    const a = conv.allowedReactions;
    const value = a == null ? 'Все' : (a.length === 0 ? 'Выключены' : `${a.length} из ${REACTIONS.length}`);
    rows.push({ group: 2, act: 'go-reactions', icon: '😀', color: 'amber', label: 'Доступные реакции', value });
  }
  if (convPerm(conv, 'addAdmins')) {
    const n = Object.keys(conv.admins || {}).length;
    rows.push({ group: 3, act: 'go-admins', icon: '🛡', color: 'purple', label: 'Администраторы', value: n ? String(n) : '' });
  }
  if (convFullAccess(conv)) {
    rows.push({ group: 4, act: 'delete', icon: '🗑', color: 'red', label: isGroup ? 'Удалить группу' : 'Удалить канал', danger: true });
  }
  return rows;
}

async function openChannelPage(convId) {
  const conv = state.conversations.find((c) => c.id === convId);
  if (!conv) return;
  channelNav.convId = convId;
  channelNav.view = 'profile';
  channelNav.members = null;
  channelNav.target = null;
  renderChannelView();
  if (state.activeSection !== 'channel') switchSection('channel');
}

function channelSetView(view) {
  channelNav.view = view;
  renderChannelView();
}

function channelGoBack() {
  const parents = {
    manage: 'profile', edit: 'manage', link: 'manage', reactions: 'manage',
    admins: 'manage', adminPick: 'admins', adminEdit: channelNav.targetIsNew ? 'adminPick' : 'admins',
  };
  channelSetView(parents[channelNav.view] || 'profile');
}

function channelMemberAvatarHtml(u) {
  return `<div class="member-avatar" style="${avatarStyle(u)}">${u.avatar ? '' : escapeHtml(initials(u.displayName))}</div>`;
}

function channelProfileHtml(conv) {
  const isOwner = conv.ownerId === state.user.id;
  const isGroup = conv.type === 'group';
  const subscribed = isSubscribedTo(conv);
  const count = (conv.participants || []).length;
  const countText = isGroup
    ? `${count} ${ruPlural(count, ['участник', 'участника', 'участников'])}`
    : `${count} ${ruPlural(count, ['подписчик', 'подписчика', 'подписчиков'])}`;
  const writeNote = isGroup ? 'Писать могут все участники' : 'Пишут владелец и администраторы';
  const adminCount = Object.keys(conv.admins || {}).length;

  const actions = [];
  if (subscribed || isOwner || state.user.isAdmin) {
    actions.push({ attr: 'data-act', act: 'open-chat', icon: 'chat', label: isGroup ? 'Открыть чат группы' : 'Открыть канал' });
  }
  if (conv.inviteCode) {
    actions.push({ attr: 'data-act', act: 'share-link', icon: 'share', label: 'Поделиться ссылкой' });
    actions.push({ attr: 'data-act', act: 'copy-link', icon: 'copy', label: 'Скопировать ссылку' });
  }

  let html = `
    <div class="pf">
      <div class="pf-hero">
        <div class="my-avatar big xl pf-avatar" id="channelInfoAvatar" style="${avatarStyle(conv)}">${conv.avatar ? '' : escapeHtml(initials(conv.name))}</div>
        <div class="pf-name">${escapeHtml(conv.name)}${verifiedBadge(conv)}${rknBadge(conv)}</div>
        <div class="pf-handle pf-handle-dim">${countText}</div>
      </div>
      ${pfActionsHtml(actions)}
      <div class="settings-list-group settings-info-group pf-card">
        <div class="settings-info-row">
          <div class="grow">
            <div class="sir-label">описание</div>
            <div class="sir-value" id="channelInfoDescription">${conv.description ? escapeHtml(conv.description).replace(/\n/g, '<br>') : '—'}</div>
          </div>
        </div>
        <div class="settings-info-row">
          <div class="grow">
            <div class="sir-label">${isGroup ? 'группа' : 'канал'}</div>
            <div class="sir-value">${writeNote}</div>
          </div>
        </div>
        ${adminCount ? `<div class="settings-info-row"><div class="grow"><div class="sir-label">администраторы</div><div class="sir-value">${adminCount}</div></div></div>` : ''}
        ${conv.inviteCode ? `<div class="settings-info-row"><div class="grow"><div class="sir-label">пригласительная ссылка</div><div class="sir-value pf-link-value">${escapeHtml(buildInviteLink(conv.inviteCode))}</div></div></div>` : ''}
        ${conv.isRegistered ? `<div class="settings-info-row pf-rkn-row" role="button" tabindex="0" data-rkn-info="${isGroup ? 'group' : 'channel'}"><span class="rkn-badge">A+</span><span class="pf-rkn-text">${isGroup ? 'Зарегистрированный чат' : 'Зарегистрированный канал'}</span><span class="pf-rkn-chev">›</span></div>` : ''}
      </div>
      ${(subscribed || isOwner) ? '<div class="pf-media" id="channelMediaSection"></div>' : ''}`;
  if (!isOwner) {
    html += `<div class="pf-cta">${subscribed
      ? `<button type="button" class="pf-cta-btn pf-cta-red" data-act="sub-toggle">${isGroup ? 'Покинуть группу' : 'Отписаться'}</button>`
      : `<button type="button" class="pf-cta-btn pf-cta-blue" data-act="sub-toggle">${isGroup ? 'Вступить в группу' : 'Подписаться'}</button>`}</div>`;
  }
  return html + '</div>';
}

function channelManageHtml(conv, rows) {
  const groups = {};
  rows.forEach((r) => { (groups[r.group] = groups[r.group] || []).push(r); });
  return Object.keys(groups).sort().map((g) => `
    <div class="settings-list-group">
      ${groups[g].map((r) => `
        <button class="settings-list-item${r.danger ? ' settings-list-item-danger' : ''}" data-act="${r.act}">
          <span class="sli-icon sli-icon-${r.color}">${r.icon}</span>
          <span class="sli-label">${escapeHtml(r.label)}</span>
          ${r.value ? `<span class="sli-value">${escapeHtml(r.value)}</span>` : ''}
          ${r.danger ? '' : '<span class="sli-chevron">›</span>'}
        </button>`).join('')}
    </div>`).join('');
}

function channelEditHtml(conv) {
  const isGroup = conv.type === 'group';
  const canInfo = convPerm(conv, 'editInfo');
  const canPhoto = convPerm(conv, 'editPhoto');
  return `
    <div class="pf pf-edit">
      <div class="pf-hero">
        <div class="profile-hero-avatar-wrap${canPhoto ? ' editable' : ''}">
          <div class="my-avatar big xl pf-avatar" id="channelInfoAvatar" style="${avatarStyle({ avatar: channelNav.avatarUrl })}">${channelNav.avatarUrl ? '' : escapeHtml(initials(conv.name))}</div>
          ${canPhoto ? '<button type="button" class="avatar-edit-fab" style="display:flex" data-act="change-avatar" title="Изменить фото" aria-label="Изменить фото">📷</button>' : ''}
        </div>
        ${canPhoto ? `<button type="button" class="profile-remove-photo-link" style="display:inline-block" data-act="remove-avatar">Удалить фото</button>
        <input type="file" id="channelAvatarInput" accept="image/*" class="hidden">` : ''}
      </div>
      ${canInfo ? `
      <div class="pf-card pf-form">
        <label class="settings-field pf-field">
          <span class="sir-label">${isGroup ? 'название группы' : 'название канала'}</span>
          <input type="text" id="channelEditName" value="${escapeHtml(conv.name)}" maxlength="100" placeholder="${isGroup ? 'Название группы' : 'Название канала'}">
        </label>
        <label class="settings-field pf-field">
          <span class="sir-label">описание</span>
          <textarea id="channelEditDescription" placeholder="${isGroup ? 'Описание группы (необязательно)' : 'Описание канала (необязательно)'}" maxlength="500">${escapeHtml(conv.description || '')}</textarea>
        </label>
      </div>
      ${isGroup ? `<div class="pf-card"><label class="checkbox-row pf-toggle-row"><span class="cr-label">Разрешить групповые звонки</span><input type="checkbox" id="channelEditGroupCalls" ${conv.groupCallsEnabled !== false ? 'checked' : ''}></label></div>` : ''}`
      : '<div class="channel-hint">Менять название и описание вам нельзя.</div>'}
      <div class="pf-cta"><button type="button" class="pf-cta-btn pf-cta-blue" data-act="save-edit">Сохранить изменения</button></div>
    </div>`;
}

function channelLinkHtml(conv) {
  const link = buildInviteLink(conv.inviteCode || '');
  const prefix = buildInviteLink('');
  return `
    <div class="modal-subtitle">Текущая ссылка</div>
    <div class="compose-invite-link">${escapeHtml(link)}</div>
    <div class="settings-avatar-actions" style="flex-direction:row;">
      <button class="btn-secondary" data-act="copy-link">Скопировать</button>
      <button class="btn-secondary" data-act="share-link">Поделиться</button>
    </div>
    <div class="modal-subtitle">Свой адрес ссылки</div>
    <div class="invite-edit-row">
      <span class="invite-prefix">${escapeHtml(prefix)}</span>
      <input type="text" id="channelEditInviteCode" value="${escapeHtml(conv.inviteCode || '')}" maxlength="32" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="мой-канал">
    </div>
    <div class="channel-hint">От 3 до 32 символов: латиница, цифры, «_» и «-». Приставки channel или group добавлять не нужно — адрес может быть любым свободным.</div>
    <div class="channel-edit-fields"><button class="btn-primary" data-act="save-link">Сохранить ссылку</button></div>`;
}

function channelReactionsHtml(conv) {
  const mode = channelNav.reactionMode;
  const row = (id, label, hint) => `
    <button class="settings-list-item" data-act="react-mode" data-mode="${id}">
      <span class="sli-label">${label}<span class="sli-sub">${hint}</span></span>
      <span class="sli-value">${mode === id ? '✓' : ''}</span>
    </button>`;
  return `
    <div class="settings-list-group">
      ${row('all', 'Все реакции', 'Участники могут ставить любые')}
      ${row('custom', 'Выбранные', 'Только отмеченные ниже')}
      ${row('none', 'Без реакций', 'Реакции на сообщения отключены')}
    </div>
    ${mode === 'custom' ? `<div class="channel-reaction-grid">${REACTIONS.map((e) => `<button type="button" class="channel-reaction-choice${channelNav.reactionSel.includes(e) ? ' active' : ''}" data-act="react-emoji" data-emoji="${e}">${e}</button>`).join('')}</div>` : ''}
    <div class="channel-edit-fields"><button class="btn-primary" data-act="save-reactions">Сохранить</button></div>`;
}

function channelAdminRowHtml(conv, u, clickable) {
  const role = u.role === 'owner' ? 'Владелец' : (u.role === 'admin' ? 'Администратор' : '');
  return `
    <button class="settings-list-item channel-member-row" ${clickable ? `data-act="${u.role === 'admin' ? 'admin-edit' : 'admin-pick'}" data-uid="${escapeHtml(u.id)}"` : 'disabled'}>
      ${channelMemberAvatarHtml(u)}
      <span class="sli-label">${escapeHtml(u.displayName)}${u.username ? `<span class="sli-sub">@${escapeHtml(u.username)}</span>` : ''}</span>
      ${role ? `<span class="sli-value">${role}</span>` : ''}
      ${clickable ? '<span class="sli-chevron">›</span>' : ''}
    </button>`;
}

function channelAdminsHtml(conv) {
  const addBtn = convPerm(conv, 'addAdmins') ? `
    <div class="settings-list-group">
      <button class="settings-list-item" data-act="admin-add">
        <span class="sli-icon sli-icon-green">＋</span>
        <span class="sli-label">Добавить администратора</span>
        <span class="sli-chevron">›</span>
      </button>
    </div>` : '';
  let list;
  if (channelNav.membersError) {
    list = `<div class="channel-hint">${escapeHtml(channelNav.membersError)}</div>`;
  } else if (!channelNav.members) {
    list = '<div class="channel-hint">Загрузка…</div>';
  } else {
    const leaders = channelNav.members.filter((u) => u.role !== 'member');
    list = `<div class="settings-list-group">${leaders.map((u) => channelAdminRowHtml(conv, u, u.role === 'admin')).join('')}</div>`;
  }
  return `${addBtn}${list}<div class="channel-hint">Нажмите на администратора, чтобы изменить его права или снять их.</div>`;
}

function channelPickHtml(conv) {
  return `
    <div class="channel-edit-fields"><input type="text" id="channelPickSearch" value="${escapeHtml(channelNav.pickQuery)}" placeholder="Поиск по имени или логину" autocomplete="off"></div>
    <div id="channelPickList"></div>`;
}

function channelPickListHtml(conv) {
  const word = conv.type === 'group' ? 'участников' : 'подписчиков';
  if (!channelNav.pickList) return '<div class="channel-hint">Загрузка…</div>';
  if (!channelNav.pickList.length) return `<div class="channel-hint">Среди ${word} никого не нашлось.</div>`;
  return `<div class="settings-list-group">${channelNav.pickList.map((u) => channelAdminRowHtml(conv, u, true)).join('')}</div>`;
}

function channelAdminEditHtml(conv) {
  const t = channelNav.target;
  if (!t) return '';
  const full = convFullAccess(conv);
  const mayEdit = full || channelNav.targetIsNew || t.promotedBy === state.user.id;
  const perms = channelNav.draftPerms || {};
  const rows = CHANNEL_PERMS.filter((p) => !(p.onlyChannel && conv.type === 'group')).map((p) => {
    const lacking = !full && !convPerm(conv, p.key);
    const disabled = !mayEdit || lacking;
    return `<label class="checkbox-row"><span class="cr-label">${p.label}${lacking && mayEdit ? '<span class="sli-sub">у вас нет этого права</span>' : ''}</span><input type="checkbox" data-perm="${p.key}" ${perms[p.key] ? 'checked' : ''} ${disabled ? 'disabled' : ''}></label>`;
  }).join('');
  return `
    <div class="profile-hero">
      <div class="my-avatar big xl" style="${avatarStyle(t)}">${t.avatar ? '' : escapeHtml(initials(t.displayName))}</div>
      <div class="profile-hero-name">${escapeHtml(t.displayName)}</div>
      ${t.username ? `<div class="profile-hero-username">@${escapeHtml(t.username)}</div>` : ''}
    </div>
    <div class="modal-subtitle">Что может делать администратор</div>
    <div class="settings-list-group channel-perm-list">${rows}</div>
    ${mayEdit ? `<div class="channel-edit-fields">
      <button class="btn-primary" data-act="save-admin">${channelNav.targetIsNew ? 'Назначить администратором' : 'Сохранить права'}</button>
      ${channelNav.targetIsNew ? '' : '<button class="btn-danger" data-act="remove-admin">Снять права администратора</button>'}
    </div>` : '<div class="channel-hint">Этого администратора назначил другой человек — менять его права можете только вы, если вы владелец.</div>'}`;
}

async function channelLoadMembers() {
  const convId = channelNav.convId;
  channelNav.membersError = '';
  try {
    const { members } = await api(`/api/conversations/${convId}/members`);
    if (channelNav.convId !== convId) return;
    channelNav.members = members;
  } catch (e) {
    channelNav.membersError = e.message || 'Не удалось загрузить список';
  }
  if (channelNav.view === 'admins' && channelNav.convId === convId) renderChannelView(true);
}

let channelPickTimer = null;
async function channelLoadPickList() {
  const convId = channelNav.convId;
  const q = channelNav.pickQuery;
  try {
    const { members } = await api(`/api/conversations/${convId}/members?limit=60&q=${encodeURIComponent(q)}`);
    if (channelNav.convId !== convId || channelNav.pickQuery !== q) return;
    channelNav.pickList = members.filter((u) => u.role === 'member');
  } catch (e) {
    channelNav.pickList = [];
  }
  const box = $('#channelPickList');
  const conv = channelConv();
  if (box && conv && channelNav.view === 'adminPick') box.innerHTML = channelPickListHtml(conv);
}

function renderChannelView(keepScroll) {
  const conv = channelConv();
  const el = $('#channelViewContent');
  if (!conv || !el) return;
  const isGroup = conv.type === 'group';
  const rows = channelManageRows(conv);
  // Права могли отобрать, пока открыт один из экранов управления.
  if (channelNav.view !== 'profile' && !rows.length) channelNav.view = 'profile';
  const view = channelNav.view;

  const titles = {
    profile: isGroup ? 'Группа' : 'Канал', manage: 'Управление', edit: 'Основное', link: 'Ссылка',
    reactions: 'Реакции', admins: 'Администраторы', adminPick: 'Новый администратор', adminEdit: 'Права администратора',
  };
  $('#channelModalTitle').textContent = titles[view] || titles.profile;
  $('#channelMoreBtn').style.visibility = (view === 'profile' && rows.length) ? 'visible' : 'hidden';
  // Главный экран канала/группы — «стеклянный» профиль с плавающими кнопками
  // вместо обычной шапки; экраны управления остаются с обычной шапкой-заголовком.
  $('#sectionChannel').classList.toggle('pf-mode', view === 'profile');

  if (view === 'edit' && !keepScroll) channelNav.avatarUrl = conv.avatar || '';
  if (view === 'reactions' && !keepScroll) {
    const a = conv.allowedReactions;
    channelNav.reactionMode = a == null ? 'all' : (a.length ? 'custom' : 'none');
    channelNav.reactionSel = Array.isArray(a) ? a.slice() : REACTIONS.slice();
  }

  let html = '';
  if (view === 'profile') html = channelProfileHtml(conv);
  else if (view === 'manage') html = channelManageHtml(conv, rows);
  else if (view === 'edit') html = channelEditHtml(conv);
  else if (view === 'link') html = channelLinkHtml(conv);
  else if (view === 'reactions') html = channelReactionsHtml(conv);
  else if (view === 'admins') html = channelAdminsHtml(conv);
  else if (view === 'adminPick') html = channelPickHtml(conv);
  else if (view === 'adminEdit') html = channelAdminEditHtml(conv);

  const prevScroll = el.scrollTop;
  el.innerHTML = html;
  el.scrollTop = keepScroll ? prevScroll : 0;
  if (!keepScroll) {
    el.classList.remove('channel-view-anim');
    void el.offsetWidth;
    el.classList.add('channel-view-anim');
  }
  channelBindView(conv, view, el);
  if (view === 'admins' && !keepScroll) { channelNav.members = null; channelLoadMembers(); }
  if (view === 'adminPick' && !keepScroll) {
    channelNav.pickQuery = '';
    channelNav.pickList = null;
    const box = $('#channelPickList');
    if (box) box.innerHTML = channelPickListHtml(conv);
    channelLoadPickList();
  }
}

function channelBindView(conv, view, el) {
  const convId = conv.id;
  const isGroup = conv.type === 'group';

  if (view === 'profile') {
    const infoAvatar = $('#channelInfoAvatar');
    if (infoAvatar && conv.avatar) {
      infoAvatar.classList.add('avatar-clickable');
      infoAvatar.title = 'Открыть фото профиля';
      infoAvatar.addEventListener('click', () => openAvatarLightbox(conv.avatar));
    }
    const mediaEl = $('#channelMediaSection');
    if (mediaEl) mountProfileMedia(mediaEl, async () => collectProfileMedia(await fetchAllMessagesForProfileMedia(conv.id)));
  }
  if (view === 'edit') {
    const avInput = $('#channelAvatarInput');
    if (avInput) avInput.addEventListener('change', async () => {
      const file = avInput.files[0];
      if (!file) return;
      try { channelNav.avatarUrl = await uploadFile(file, 'avatar'); } catch (e) { alert(e.message || 'Не удалось загрузить фото'); return; }
      const prev = $('#channelInfoAvatar');
      prev.style.cssText = `background-image:url('${channelNav.avatarUrl}')`;
      prev.textContent = '';
    });
  }
  if (view === 'adminPick') {
    const search = $('#channelPickSearch');
    if (search) search.addEventListener('input', () => {
      channelNav.pickQuery = search.value.trim();
      channelNav.pickList = null;
      $('#channelPickList').innerHTML = channelPickListHtml(conv);
      clearTimeout(channelPickTimer);
      channelPickTimer = setTimeout(channelLoadPickList, 250);
    });
  }

  el.onclick = async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    const act = t.dataset.act;
    const cur = channelConv();
    if (!cur) return;
    try {
      if (act === 'copy-link') {
        navigator.clipboard.writeText(buildInviteLink(cur.inviteCode)).catch(() => {});
        if (t.classList.contains('pf-action')) {
          t.classList.add('pf-done');
          setTimeout(() => t.classList.remove('pf-done'), 1500);
        } else {
          const old = t.textContent;
          t.textContent = 'Скопировано!';
          setTimeout(() => { t.textContent = old; }, 1500);
        }
      } else if (act === 'open-chat') {
        switchSection('chats');
        await openConversation(cur.id);
      } else if (act === 'share-link') {
        openShareModal(cur.name, buildInviteLink(cur.inviteCode));
      } else if (act === 'sub-toggle') {
        if (isSubscribedTo(cur)) {
          if (!confirm(isGroup ? 'Покинуть эту группу?' : 'Отписаться от этого канала?')) return;
          await api(`/api/conversations/${convId}/unsubscribe`, { method: 'POST' });
          state.conversations = state.conversations.filter((c) => c.id !== convId);
          switchSection(state.subpageReturnSection || 'chats');
          closeActiveChat();
        } else {
          const { conversation } = await api(`/api/conversations/${convId}/subscribe`, { method: 'POST' });
          mergeConversation(conversation);
          switchSection(state.subpageReturnSection || 'chats');
        }
      } else if (act === 'go-edit') channelSetView('edit');
      else if (act === 'go-link') channelSetView('link');
      else if (act === 'go-reactions') channelSetView('reactions');
      else if (act === 'go-admins') channelSetView('admins');
      else if (act === 'delete') {
        if (!confirm(`${isGroup ? 'Удалить группу' : 'Удалить канал'} «${cur.name}» безвозвратно?`)) return;
        await api(`/api/conversations/${convId}`, { method: 'DELETE' });
        state.conversations = state.conversations.filter((c) => c.id !== convId);
        switchSection(state.subpageReturnSection || 'chats');
        closeActiveChat();
      } else if (act === 'change-avatar') {
        $('#channelAvatarInput').click();
      } else if (act === 'remove-avatar') {
        channelNav.avatarUrl = '';
        const prev = $('#channelInfoAvatar');
        prev.style.cssText = '';
        prev.textContent = initials(cur.name);
      } else if (act === 'save-edit') {
        const body = {};
        if (convPerm(cur, 'editInfo')) {
          const name = $('#channelEditName').value.trim();
          if (!name) { alert('Название не может быть пустым'); return; }
          body.name = name;
          body.description = $('#channelEditDescription').value.trim();
          const calls = $('#channelEditGroupCalls');
          if (calls) body.groupCallsEnabled = calls.checked;
        }
        if (convPerm(cur, 'editPhoto')) body.avatar = channelNav.avatarUrl;
        const { conversation } = await api(`/api/conversations/${convId}`, { method: 'PATCH', body });
        mergeConversation(conversation);
        channelSetView('manage');
      } else if (act === 'save-link') {
        const code = $('#channelEditInviteCode').value.trim();
        const { conversation } = await api(`/api/conversations/${convId}`, { method: 'PATCH', body: { inviteCode: code } });
        mergeConversation(conversation);
        channelSetView('manage');
      } else if (act === 'react-mode') {
        channelNav.reactionMode = t.dataset.mode;
        renderChannelView(true);
      } else if (act === 'react-emoji') {
        const emoji = t.dataset.emoji;
        const sel = channelNav.reactionSel;
        const idx = sel.indexOf(emoji);
        if (idx === -1) sel.push(emoji); else sel.splice(idx, 1);
        t.classList.toggle('active', idx === -1);
      } else if (act === 'save-reactions') {
        let allowed = null;
        if (channelNav.reactionMode === 'none') allowed = [];
        else if (channelNav.reactionMode === 'custom') {
          allowed = REACTIONS.filter((r) => channelNav.reactionSel.includes(r));
          if (!allowed.length) { alert('Отметьте хотя бы одну реакцию или выберите «Без реакций»'); return; }
        }
        const { conversation } = await api(`/api/conversations/${convId}`, { method: 'PATCH', body: { allowedReactions: allowed } });
        mergeConversation(conversation);
        channelSetView('manage');
      } else if (act === 'admin-add') {
        channelSetView('adminPick');
      } else if (act === 'admin-pick') {
        const u = (channelNav.pickList || []).find((x) => x.id === t.dataset.uid);
        if (!u) return;
        channelNav.target = u;
        channelNav.targetIsNew = true;
        channelNav.draftPerms = { ...CHANNEL_DEFAULT_PERMS };
        CHANNEL_PERMS.forEach((p) => { if (channelNav.draftPerms[p.key] && !convPerm(cur, p.key)) channelNav.draftPerms[p.key] = false; });
        channelSetView('adminEdit');
      } else if (act === 'admin-edit') {
        const u = (channelNav.members || []).find((x) => x.id === t.dataset.uid);
        if (!u) return;
        channelNav.target = u;
        channelNav.targetIsNew = false;
        channelNav.draftPerms = { ...(u.perms || {}) };
        channelSetView('adminEdit');
      } else if (act === 'save-admin') {
        const permissions = {};
        el.querySelectorAll('[data-perm]').forEach((cb) => { permissions[cb.dataset.perm] = cb.checked; });
        if (!Object.values(permissions).some(Boolean)) { alert('Включите хотя бы одно право — или снимите права администратора'); return; }
        const { conversation } = await api(`/api/conversations/${convId}/admins`, { method: 'POST', body: { userId: channelNav.target.id, permissions } });
        mergeConversation(conversation);
        channelNav.members = null;
        channelNav.targetIsNew = false;
        channelSetView('admins');
      } else if (act === 'remove-admin') {
        if (!confirm(`Снять права администратора с «${channelNav.target.displayName}»?`)) return;
        const { conversation } = await api(`/api/conversations/${convId}/admins`, { method: 'POST', body: { userId: channelNav.target.id, permissions: null } });
        mergeConversation(conversation);
        channelNav.members = null;
        channelSetView('admins');
      }
    } catch (err) {
      alert(err.message || 'Не удалось выполнить действие');
    }
  };
}

/* ---------------- MESSAGES RENDER ---------------- */

// Туман у краёв списка сообщений включаем только когда сообщения реально
// не помещаются на экран и есть что скроллить — если переписка короткая,
// никакого тумана нет, только плавающие стеклянные панели сверху/снизу.
// Верхний и нижний туман переключаются НЕЗАВИСИМО, по реальной позиции
// скролла: если долистали до самого начала — верхнего тумана быть не
// должно (даже если снизу ещё есть, что скроллить), и наоборот для конца
// переписки — иначе туман закрывает последние/первые сообщения навсегда.
const FOG_EDGE_THRESHOLD = 24;
function updateChatFogState() {
  const el = $('#messages');
  const chatActive = $('#chatActive');
  if (!el || !chatActive) return;
  const overflowing = el.scrollHeight - el.clientHeight > 48;
  const atTop = el.scrollTop <= FOG_EDGE_THRESHOLD;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOG_EDGE_THRESHOLD;
  el.classList.toggle('has-overflow', overflowing);
  chatActive.classList.toggle('has-fog-top', overflowing && !atTop);
  chatActive.classList.toggle('has-fog-bottom', overflowing && !atBottom);
  // Круглая кнопка "вниз ленты" — показываем, только когда есть, куда
  // скроллить, и лента прокручена вверх (не у самого последнего сообщения).
  const scrollBtn = $('#scrollToBottomBtn');
  if (scrollBtn) scrollBtn.classList.toggle('hidden', !overflowing || atBottom);
  positionScrollBtn();
}
window.addEventListener('resize', updateChatFogState);
$('#messages') && $('#messages').addEventListener('scroll', updateChatFogState);

// Кнопка "вниз ленты" раньше была прибита к фиксированному bottom: 70px,
// поэтому при расширении нижней панели (многострочный ввод, панель ответа
// на сообщение, бар подписки на канал, бар "Начать" у ботов) она уезжала
// под эти панели вместо того, чтобы подняться вместе с ними. Теперь bottom
// пересчитывается от реальной суммарной высоты всех видимых панелей под
// лентой сообщений.
const SCROLL_BTN_BAR_SELECTORS = ['#replyPreviewBar', '#channelSubscribedBar', '#botStartBar', '#composer'];
function positionScrollBtn() {
  const scrollBtn = $('#scrollToBottomBtn');
  if (!scrollBtn) return;
  let stack = 0;
  for (const sel of SCROLL_BTN_BAR_SELECTORS) {
    const el = $(sel);
    if (el && !el.classList.contains('hidden')) stack += el.getBoundingClientRect().height;
  }
  scrollBtn.style.bottom = `calc(${Math.round(stack)}px + 14px)`;
}
(() => {
  if (typeof ResizeObserver === 'undefined') return;
  const ro = new ResizeObserver(() => positionScrollBtn());
  SCROLL_BTN_BAR_SELECTORS.forEach(sel => { const el = $(sel); if (el) ro.observe(el); });
})();

$('#scrollToBottomBtn') && $('#scrollToBottomBtn').addEventListener('click', () => {
  const el = $('#messages');
  if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
});

// Сколько сообщений подгружаем за раз (и при первом открытии чата, и при
// подгрузке истории вверх при скролле) — см. openConversation() и
// loadOlderMessages() ниже.
const MESSAGES_PAGE_SIZE = 40;

function renderMessages(opts) {
  const preserveScroll = !!(opts && opts.preserveScroll);
  const el = $('#messages');
  // БАГ: раньше preserveScroll ничего не сохранял — el.innerHTML = '' сбрасывал
  // scrollTop в 0, а при preserveScroll=false ниже ещё и прыгали в самый низ.
  // Запоминаем позицию до очистки и возвращаем после перерисовки.
  const prevScrollTop = el.scrollTop;
  el.innerHTML = '';
  const list = state.messages[state.activeConvId] || [];
  const pendingRows = pendingList(state.activeConvId);
  el.classList.toggle('is-empty', list.length === 0 && !pendingRows.length);
  if (list.length === 0 && !pendingRows.length) {
    el.appendChild(renderEmptyChatPlaceholder());
  } else {
    let lastDayKey = null;
    list.forEach((m) => {
      const dayKey = dayKeyOf(m.createdAt);
      if (dayKey !== lastDayKey) {
        el.appendChild(renderDateSeparator(m.createdAt));
        lastDayKey = dayKey;
      }
      el.appendChild(renderMessageBubble(m));
    });
    pendingRows.forEach((p) => { try { el.appendChild(renderPendingRow(p)); } catch (e) {} });
  }
  if (preserveScroll) el.scrollTop = prevScrollTop;
  else el.scrollTop = el.scrollHeight;
  updateChatFogState();
  updateComposerVisibility(state.conversations.find((c) => c.id === state.activeConvId));
}

// Точечно перерисовывает ОДНО сообщение (реакция, голос в опросе), не трогая
// остальную ленту: позиция прокрутки не прыгает, видео в других сообщениях
// не перезапускаются. Если пользователь был у самого низа — остаётся у низа;
// иначе сообщение остаётся на том же месте экрана, даже если его высота
// изменилась (появилась строка реакций). Возвращает false, если строки нет
// в DOM — тогда вызывающий делает полную перерисовку с сохранением прокрутки.
function rerenderMessageInPlace(messageId) {
  const el = $('#messages');
  const list = state.messages[state.activeConvId] || [];
  const m = list.find((mm) => mm.id === messageId);
  const oldRow = el.querySelector(`.msg-row[data-msg-id="${messageId}"]`);
  if (!m || !oldRow) return false;
  const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  const topBefore = oldRow.getBoundingClientRect().top;
  const newRow = renderMessageBubble(m);
  oldRow.replaceWith(newRow);
  if (wasAtBottom) el.scrollTop = el.scrollHeight;
  else el.scrollTop += newRow.getBoundingClientRect().top - topBefore;
  return true;
}

// Подгрузка более старой истории при скролле вверх ("бесконечная лента").
// Срабатывает, когда лента прокручена почти до самого верха — заранее, с
// небольшим запасом, чтобы пользователь не успевал упереться в потолок и
// увидеть пустоту, пока грузится следующая порция.
$('#messages').addEventListener('scroll', () => {
  const el = $('#messages');
  if (el.scrollTop > 80) return;
  const convId = state.activeConvId;
  if (!convId || !state.messagesHasMore[convId] || state.messagesLoadingOlder) return;
  loadOlderMessages(convId);
}, { passive: true });

async function loadOlderMessages(convId) {
  const list = state.messages[convId] || [];
  const oldest = list[0];
  if (!oldest) return;
  state.messagesLoadingOlder = true;
  try {
    const { messages, hasMore } = await api(`/api/conversations/${convId}/messages?limit=${MESSAGES_PAGE_SIZE}&before=${oldest.createdAt}`);
    state.messagesHasMore[convId] = !!hasMore;
    if (!messages.length) return;
    state.messages[convId] = messages.concat(state.messages[convId] || []);
    // Пользователь мог успеть переключиться на другой чат, пока грузилась
    // эта порция — тогда в DOM их не вставляем, просто сохраняем в state,
    // отрисуется само при следующем открытии этого чата.
    if (state.activeConvId === convId) prependOlderMessages(messages);
  } catch (e) {
    // тихо игнорируем — при следующей прокрутке вверх попытка повторится
  } finally {
    state.messagesLoadingOlder = false;
  }
}

// Вставляет уже загруженные старые сообщения В НАЧАЛО ленты одним куском,
// без полной перерисовки уже показанных сообщений — иначе у всех видео-
// превью ниже заново запускался бы автоплей, а лента бы моргала.
// Сохраняет позицию скролла так, чтобы то сообщение, на которое сейчас
// смотрит пользователь, осталось на том же месте экрана.
function prependOlderMessages(olderMessages) {
  const el = $('#messages');
  const prevScrollHeight = el.scrollHeight;
  const prevScrollTop = el.scrollTop;
  const frag = document.createDocumentFragment();
  let lastDayKey = null;
  olderMessages.forEach((m) => {
    const dayKey = dayKeyOf(m.createdAt);
    if (dayKey !== lastDayKey) {
      frag.appendChild(renderDateSeparator(m.createdAt));
      lastDayKey = dayKey;
    }
    frag.appendChild(renderMessageBubble(m));
  });
  // Если первый уже отрисованный элемент — плашка даты того же дня, что и
  // последнее из новых старых сообщений, она задвоится с только что
  // вставленной — убираем дубликат, оставляя одну плашку на день.
  const firstChild = el.firstChild;
  if (firstChild && firstChild.classList && firstChild.classList.contains('date-separator')) {
    const lastOlderDayKey = String(dayKeyOf(olderMessages[olderMessages.length - 1].createdAt));
    if (firstChild.dataset.dayKey === lastOlderDayKey) firstChild.remove();
  }
  el.insertBefore(frag, el.firstChild);
  el.scrollTop = el.scrollHeight - prevScrollHeight + prevScrollTop;
  updateChatFogState();
}

// Плашка "нет сообщений" — та же логика аватара/имени, что и в шапке чата
// (renderChatHeader), просто по центру экрана: аватар собеседника/чата
// сверху, имя жирным, и подпись-подсказка снизу.
function renderEmptyChatPlaceholder() {
  const conv = state.conversations.find((c) => c.id === state.activeConvId);
  const box = document.createElement('div');
  box.className = 'empty-chat-placeholder';
  if (!conv) return box;
  const title = convTitle(conv);
  const avatarSubject = conv.type === 'dm' ? conv.peer : conv;
  const avatarUrl = avatarSubject && avatarSubject.avatar;
  box.innerHTML = `
    <div class="avatar${avatarRingClass(conv.type === 'dm' ? conv.peer : null)}" style="${avatarUrl ? avatarStyle(avatarSubject) : ''}">${avatarUrl ? '' : initials(title)}</div>
    <div class="empty-chat-name">${escapeHtml(title)}</div>
    <div class="empty-chat-hint">Напишите первое сообщение</div>
  `;
  return box;
}

// Добавляет одно новое сообщение с мягкой анимацией появления, не трогая
// уже отрисованные сообщения (чтобы список не "дёргался" целиком при каждом
// новом сообщении — анимируется только то, что реально только что пришло).
function appendMessageBubble(m) {
  const el = $('#messages');
  if (el.classList.contains('is-empty')) {
    el.classList.remove('is-empty');
    el.innerHTML = ''; // убираем плашку "нет сообщений" — теперь оно есть
    updateComposerVisibility(state.conversations.find((c) => c.id === state.activeConvId));
  }
  const wasNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  // Новое сообщение — из другого календарного дня, чем последнее уже
  // отрисованное? Вставляем перед ним свежую плашку-разделитель ("Сегодня"
  // и т.п.), точно так же, как при полной перерисовке в renderMessages().
  const dayKey = String(dayKeyOf(m.createdAt));
  const separators = el.querySelectorAll('.date-separator');
  const lastSeparator = separators.length ? separators[separators.length - 1] : null;
  const firstPending = el.querySelector('.msg-row.msg-pending'); // «ожидающие» вложения всегда остаются внизу
  if (!lastSeparator || lastSeparator.dataset.dayKey !== dayKey) {
    const sep = renderDateSeparator(m.createdAt);
    sep.classList.add('msg-enter');
    el.insertBefore(sep, firstPending);
  }
  const row = renderMessageBubble(m);
  row.classList.add('msg-enter');
  el.insertBefore(row, firstPending);
  if (wasNearBottom) el.scrollTop = el.scrollHeight;
  updateChatFogState();
}

// Серая/синяя точка рядом со временем — статус прочтения. Пока реализовано
// для личных чатов (там однозначно понятно, кто именно должен прочитать):
// синяя, если собеседник открывал чат позже момента отправки сообщения.
function buildReadDotHtml(m) {
  if (m.senderId !== state.user.id) return '';
  const conv = state.conversations.find((c) => c.id === state.activeConvId);
  if (!conv || conv.type !== 'dm' || !conv.peer) return '';
  const peerReadAt = (conv.reads && conv.reads[conv.peer.id]) || 0;
  const isRead = peerReadAt >= m.createdAt;
  return `<span class="read-dot ${isRead ? 'read' : 'unread'}" title="${isRead ? 'Прочитано' : 'Отправлено, не прочитано'}"></span>`;
}

function renderMessageBubble(m) {
  const row = document.createElement('div');
  row.className = 'msg-row' + (m.senderId === state.user.id ? ' mine' : '');
  row.dataset.msgId = m.id;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  let inner = '';
  const senderName = m.senderId === state.user.id ? '' : `<div class="sender">${escapeHtml(senderLabel(m.senderId))}${verifiedBadge(findKnownUser(m.senderId))}</div>`;
  if (m.senderId !== state.user.id && !senderIsKnown(m.senderId)) {
    ensureUserCached(m.senderId).then((u) => {
      if (!u) return;
      const el = row.querySelector('.sender');
      if (el) el.innerHTML = escapeHtml(u.displayName) + verifiedBadge(u);
    });
  }
  let replyBlock = '';
  if (m.replyPreview) {
    const rp = m.replyPreview;
    replyBlock = `<div class="reply-quote" data-reply-to="${rp.id}"><div class="reply-quote-name">${escapeHtml(rp.senderName)}</div><div class="reply-quote-text">${escapeHtml(replyPreviewLabel(rp))}</div></div>`;
  }
  // Ответ на историю: карточка с миниатюрой истории над текстом ответа.
  // Если история уже истекла и файл удалён, миниатюра прячется (onerror), остаётся подпись.
  if (m.meta && m.meta.storyReply) {
    const sr = m.meta.storyReply;
    const mineStory = sr.authorId === state.user.id;
    const thumb = sr.mediaUrl
      ? (sr.mediaType === 'video'
          ? `<video class="story-reply-thumb" src="${escapeHtml(sr.mediaUrl)}#t=0.1" muted playsinline preload="metadata" onerror="this.remove()"></video>`
          : `<img class="story-reply-thumb" src="${escapeHtml(sr.mediaUrl)}" alt="" onerror="this.remove()">`)
      : '';
    replyBlock = `<div class="reply-quote story-reply-quote">${thumb}<div class="story-reply-meta"><div class="reply-quote-name">${mineStory ? 'Ответ на вашу историю' : 'История'}</div><div class="reply-quote-text">${escapeHtml(sr.caption || (sr.mediaType === 'video' ? '🎬 Видео' : '🖼 Фото'))}</div></div></div>`;
  }
  let forwardBlock = '';
  if (m.forwardFrom) {
    forwardBlock = `<div class="forward-label">↪️ Переслано от ${escapeHtml(m.forwardFrom.senderName)}</div>`;
  }
  if (m.msgType === 'text') inner = `<span class="msg-text">${formatMessageText(m.content)}</span>`;
  else if (m.msgType === 'sticker') inner = `<div class="sticker-emoji">${m.content}</div>`;
  else if (m.msgType === 'image') inner = `<div class="media-frame"><div class="media-frame-bg" style="background-image:url('${m.mediaUrl}')"></div><img class="media-frame-img" src="${m.mediaUrl}" data-lightbox="1"></div>`;
  else if (m.msgType === 'video') inner = `<div class="media-frame media-frame-video"><video class="media-frame-bg-video" src="${m.mediaUrl}" muted autoplay loop playsinline></video><video class="media-frame-video-fg" src="${m.mediaUrl}" muted autoplay loop playsinline data-lightbox="1" data-lightbox-type="video"></video></div>`;
  else if (m.msgType === 'video_circle') inner = `<div class="circle-video-wrap"><video class="circle-video" src="${m.mediaUrl}" playsinline muted preload="metadata"></video><svg class="circle-progress" viewBox="0 0 100 100"><circle class="circle-progress-track" cx="50" cy="50" r="47"></circle><circle class="circle-progress-bar" cx="50" cy="50" r="47"></circle></svg><button type="button" class="circle-mute-btn" title="Включить звук">🔇</button><button type="button" class="circle-totext-btn" title="Расшифровать в текст">→T</button><div class="circle-elapsed">0:00</div></div>`;
  else if (m.msgType === 'voice') inner = `<div class="voice-msg-wrap"><audio class="voice-audio" src="${m.mediaUrl}" controls></audio><button type="button" class="voice-totext-btn" title="Расшифровать в текст">→T</button></div>`;
  else if (m.msgType === 'music') inner = `<div class="music-name">🎵 ${escapeHtml((m.meta && m.meta.name) || 'Трек')}</div><audio src="${m.mediaUrl}" controls></audio>`;
  else if (m.msgType === 'file') {
    // БАГ «названия файлов портятся при скачивании»: на диске сервера файл
    // лежит под случайным id, и ссылка вела прямо на него — скачивался файл
    // с этим id вместо настоящего имени. Теперь ссылка просит сервер отдать
    // файл как вложение с исходным именем (?dl=1&name=...).
    const fileName = sanitizeFilename((m.meta && m.meta.name) || '') || 'file';
    inner = `<a class="file-chip" href="${escapeHtml(uploadDownloadHref(m.mediaUrl, fileName))}" download="${escapeHtml(fileName)}" style="color:inherit;text-decoration:none;"><span class="file-chip-ico">📄</span><span class="file-chip-name">${escapeHtml((m.meta && m.meta.name) || 'Файл')}</span></a>`;
  }
  else if (m.msgType === 'poll') inner = renderPollBubble(m);
  else if (m.msgType === 'location') inner = renderLocationBubble(m);
  else if (m.msgType === 'album') inner = renderAlbumBubble(m);
  const editedTag = m.edited ? '<span class="edited-tag">(изменено)</span>' : '';
  const readDot = buildReadDotHtml(m);
  // Фото/видео/кружок/альбом показываем как в Telegram: медиа во весь размер
  // пузыря без отступов. Если подписи нет — время и статус прочтения
  // плавают плашкой прямо поверх картинки. Если подпись есть — фото всё
  // равно во всю ширину без рамки, а под ним вплотную идёт полоса с
  // подписью (фон пузыря) и временем/галочкой в её правом углу.
  const hasCaption = (m.msgType === 'image' || m.msgType === 'video' || m.msgType === 'album') && !!m.content;
  const isBareMedia = m.msgType === 'video_circle' || ((m.msgType === 'video' || m.msgType === 'image' || m.msgType === 'album') && !m.content);
  let timeBlock = '';
  if (hasCaption) {
    bubble.classList.add('media-only', 'has-caption');
    inner += `<div class="media-caption-bar"><span class="msg-text">${formatMessageText(m.content)}</span><span class="time">${fmtTime(m.createdAt)}${editedTag}${readDot}</span></div>`;
  } else if (isBareMedia) {
    bubble.classList.add('media-only');
    if (m.msgType === 'video_circle') bubble.classList.add('circle-media');
    timeBlock = `<div class="time media-time-overlay">${fmtTime(m.createdAt)}${editedTag}${readDot}</div>`;
  } else {
    timeBlock = `<div class="time">${fmtTime(m.createdAt)}${editedTag}${readDot}</div>`;
  }
  bubble.innerHTML = senderName + forwardBlock + replyBlock + inner + timeBlock;
  if (m.msgType === 'poll') { bubble.classList.add('poll-msg'); bubble.insertAdjacentHTML('beforeend', pollFooterHtml(m)); }

  // Баг «у фото с реакцией время съезжает и появляется голый фон под ним»:
  // .media-time-overlay (плашка времени поверх фото/видео/кружка) выше
  // добавлялась в bubble.innerHTML СИБЛИНГОМ рядом с .media-frame, а не
  // внутрь него. Пока у сообщения не было реакций, высота .bubble по сути
  // равнялась высоте .media-frame — и position:absolute; bottom:8px у
  // плашки времени (которая считается от ближайшего спозиционированного
  // предка, т.е. от .bubble) визуально совпадала с нижним краем картинки.
  // Как только к сообщению добавляли реакцию — ниже дорисовывался ещё один
  // элемент, .reactions-row (обычный поток, с своим margin), — .bubble
  // становился выше картинки на высоту этой строки, а плашка времени,
  // прибитая к низу именно .bubble (а не картинки), съезжала вниз вместе
  // с этим приростом высоты: оказывалась в пустой полосе под фото рядом с
  // реакцией, а не поверх самого фото, как задумано. Чиним, перенося
  // плашку времени внутрь фактического контейнера медиа (.media-frame /
  // .circle-video-wrap / .album-grid — у всех троих уже есть
  // position:relative и размер точно по картинке/сетке), чтобы bottom/right
  // всегда считались от границ самого изображения, а не всего пузыря.
  if (isBareMedia) {
    const overlayEl = bubble.querySelector('.media-time-overlay');
    const mediaContainerEl = bubble.querySelector('.media-frame, .circle-video-wrap, .album-grid');
    if (overlayEl && mediaContainerEl) mediaContainerEl.appendChild(overlayEl);
  }

  // Баг «подпись/реакции/следующее сообщение наезжают на медиа, пока не
  // тронешь экран»: у сообщений с фото/видео/альбомом (.bubble.media-only)
  // при ПЕРВОЙ отрисовке мобильный WebView иногда успевает закэшировать
  // геометрию (размер и позицию) пузыря ДО того, как реально загрузились
  // все картинки/видео внутри — а перерисовать уже закэшированный слой
  // самостоятельно после их загрузки не удосуживается. Из-за этого пузырь
  // визуально "застревает" в старом (более узком/коротком) размере: текст
  // следующего сообщения, реакции и время рисуются там, где они были бы
  // при правильном размере, а сама картинка/сетка альбома прорисовывается
  // поверх них внахлёст. Раньше это чинилось только у одиночного фото/видео
  // с подписью (единственный .media-frame-img/.media-frame-video-fg) — у
  // альбомов (по нескольку картинок сразу, из-за чего эффект заметнее
  // всего) такого чиняющего пересчёта не было вообще. Теперь ждём загрузки
  // ВСЕХ картинок/видео внутри пузыря (одиночных и всех плиток альбома) и
  // один раз форсируем пересчёт раскладки — так же, как раньше чинился
  // поворот экрана (он тоже просто вызывал полный resize).
  if (bubble.classList.contains('media-only')) {
    const mediaEls = Array.from(bubble.querySelectorAll('.media-frame-img, .media-frame-video-fg, .album-tile img, .album-tile video'));
    if (mediaEls.length) {
      const forceReflow = () => {
        // display:none полностью выкидывает элемент из дерева рендера, а не
        // просто помечает грязным — только это гарантированно сбрасывает
        // закешированные (ещё «до-загрузочные») размеры внутри. Оба
        // присваивания синхронные и происходят в одном тике до отрисовки
        // кадра, так что видимого мигания нет — пользователь увидит только
        // уже исправленную раскладку.
        bubble.style.display = 'none';
        void bubble.offsetHeight;
        bubble.style.display = '';
      };
      let pending = 0;
      const onOneReady = () => { pending -= 1; if (pending <= 0) forceReflow(); };
      mediaEls.forEach((mediaEl) => {
        const isImg = mediaEl.tagName === 'IMG';
        const ready = isImg ? mediaEl.complete : mediaEl.readyState >= 1;
        if (!ready) {
          pending += 1;
          mediaEl.addEventListener(isImg ? 'load' : 'loadedmetadata', onOneReady, { once: true });
        }
      });
      // Всё уже было в кэше браузера — всё равно перерисуем один раз лишним
      // не будет, а если это первая загрузка сообщения после долгой сессии,
      // как раз чинит тот самый застрявший layout.
      if (pending === 0) forceReflow();
    }
  }

  const replyQuoteEl = bubble.querySelector('.reply-quote');
  if (replyQuoteEl) replyQuoteEl.addEventListener('click', () => scrollToMessage(replyQuoteEl.dataset.replyTo));

  // клики по вариантам опроса
  if (m.msgType === 'poll') {
    bubble.querySelectorAll('.poll-option').forEach((optEl) => {
      optEl.addEventListener('click', () => votePoll(m.id, optEl.dataset.opt));
    });
    const toggleBtn = bubble.querySelector('[data-poll-toggle]');
    if (toggleBtn) toggleBtn.addEventListener('click', () => {
      if (pollVotersShown.has(m.id)) pollVotersShown.delete(m.id); else pollVotersShown.add(m.id);
      if (!rerenderMessageInPlace(m.id)) renderMessages({ preserveScroll: true });
    });
  }

  // реакции
  if (m.reactions && Object.keys(m.reactions).length) {
    const rr = document.createElement('div');
    rr.className = 'reactions-row';
    Object.entries(m.reactions).forEach(([emoji, uids]) => {
      const pill = document.createElement('span');
      pill.className = 'reaction-pill' + (uids.includes(state.user.id) ? ' mine' : '');
      pill.textContent = `${emoji} ${uids.length}`;
      pill.addEventListener('click', () => sendReaction(m.id, emoji));
      const fx = reactionFx.pending;
      if (fx && fx.messageId === m.id && fx.emoji === emoji && uids.includes(state.user.id) && Date.now() - fx.at < 4000) {
        reactionFx.pending = null;
        pill.classList.add('pill-pop');
        requestAnimationFrame(() => { if (pill.isConnected) playReactionBurst(pill, emoji); });
      }
      rr.appendChild(pill);
    });
    // у фото/видео с подписью реакции кладём внутрь полосы подписи (она и есть
    // «блок сообщения»); у остальных — в конец пузыря, как раньше.
    const captionBar = bubble.querySelector('.media-caption-bar');
    (captionBar || bubble).appendChild(rr);
  }

  row.appendChild(bubble);

  // Меню действий над сообщением (реакция/ответить/копировать/изменить/
  // удалить) теперь открывается ТОЛЬКО долгим нажатием на сообщение —
  // отдельной панели, всплывающей по наведению курсора, больше нет.

  // долгое нажатие на само сообщение — реакции + изменить/удалить, с размытием фона
  attachLongPress(bubble, () => openMsgContextMenu(bubble, row, m), () => {});

  // лайтбокс на фото/видео — превью видео в чате играет само по себе
  // (беззвучно и по кругу, как gif), а тап по нему, как и по фото,
  // открывает полноэкранный просмотр со звуком и обычным плеером.
  // Для альбома плиток несколько — у каждой свой data-item-idx (позиция
  // внутри альбома), поэтому перебираем все, а не берём только первую.
  bubble.querySelectorAll('[data-lightbox]').forEach((trigger) => {
    const hasIdx = trigger.dataset.itemIdx !== undefined;
    const itemIdx = hasIdx ? Number(trigger.dataset.itemIdx) : null;
    const url = hasIdx && m.meta && m.meta.items ? (m.meta.items[itemIdx] && m.meta.items[itemIdx].url) : m.mediaUrl;
    trigger.addEventListener('click', () => openLightbox(url, trigger.dataset.lightboxType || 'image', m.id, itemIdx));
  });

  // проигрыватель видео-кружка
  if (m.msgType === 'video_circle') setupCircleVideoPlayer(bubble, m);

  // кнопка расшифровки голосового сообщения в текст
  if (m.msgType === 'voice') {
    const voiceWrap = bubble.querySelector('.voice-msg-wrap');
    if (voiceWrap) {
      const voiceToTextBtn = voiceWrap.querySelector('.voice-totext-btn');
      voiceToTextBtn.addEventListener('click', transcribeBtnClickHandler(bubble, '.voice-msg-wrap', m));
    }
  }

  return row;
}

// Проигрыватель кружка (видео-сообщения): клик по кружку запускает/ставит
// на паузу, во время игры кружок увеличивается и звучит, кольцо вокруг
// него заполняется белой дугой по мере проигрывания, счётчик слева внизу
// показывает текущее время. Кнопка справа сверху — заглушка расшифровки
// голоса в текст, кнопка снизу — быстрое вкл/выкл звука без остановки игры.
//
// Раньше увеличение делалось через transform: scale(1.32) от центра
// кружка. Если кружок был близко к правому/левому краю экрана (а "свои"
// сообщения обычно почти вплотную к краю), увеличенный кружок вылезал за
// пределы .messages — контейнер со scroll по Y автоматически получает
// overflow-x:auto, и торчащая часть кружка просто обрезалась/скрывалась,
// а не была видна целиком. Теперь при разворачивании весь .bubble целиком
// (не только видео внутри) временно становится position:fixed, а JS сам
// подбирает координаты так, чтобы увеличенный круг целиком помещался в
// видимую область чата. Двигаем именно весь пузырь, а не только
// .circle-video-wrap — иначе плашка времени/статуса прочтения (она лежит
// в .bubble рядом с wrap, а не внутри него) осталась бы на старом месте,
// пока сам кружок улетал в новую точку экрана.
let activeExpandedCircle = null; // { bubble, collapse } — сейчас развёрнутый кружок, если есть
// >0 — игнорируем событие scroll, вызванное НАШИМ же программным сдвигом
// ленты (см. isLastRow-ветку в setupCircleVideoPlayer), а не прокруткой
// руками пользователя. Иначе такой сдвиг сам себя тут же схлопывал бы
// через обработчик ниже. Счётчик (а не флаг) — чтобы вложенные/повторные
// анимации (быстрый повторный тап) не сбивали друг друга.
let circleAutoScrollDepth = 0;
$('#messages').addEventListener('scroll', () => {
  if (circleAutoScrollDepth > 0) return;
  if (activeExpandedCircle && activeExpandedCircle.collapse) activeExpandedCircle.collapse();
}, { passive: true });

// Плавно докручивает ленту сообщений на deltaY пикселей за duration мс,
// той же кривой, что и transition развёрнутого кружка (--ease-liquid),
// чтобы сдвиг предыдущих сообщений визуально совпадал по темпу с ростом
// самого кружка, а не дёргался мгновенным скачком.
function animateMessagesScroll(el, deltaY, duration) {
  if (!deltaY) return;
  const startTop = el.scrollTop;
  const startTime = performance.now();
  circleAutoScrollDepth++;
  let done = false;
  // БАГ «кружок, после которого ничего не отправлено, начинает багаться»:
  // событие scroll доставляется браузером асинхронно — ПОСЛЕ последнего
  // кадра анимации. Если снимать защиту (circleAutoScrollDepth) прямо в
  // последнем кадре, финальное scroll-событие нашей же анимации прилетало
  // уже при depth === 0, принималось за прокрутку пальцем и тут же
  // схлопывало только что развёрнутый кружок. Снимаем защиту с запасом.
  const finish = () => { if (done) return; done = true; setTimeout(() => { circleAutoScrollDepth--; }, 150); };
  const step = (now) => {
    const t = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic, близко к --ease-liquid
    el.scrollTop = startTop + deltaY * eased;
    if (t < 1) requestAnimationFrame(step);
    else finish();
  };
  requestAnimationFrame(step);
}

/* ---------------- РАСШИФРОВКА ГОЛОСА В ТЕКСТ ----------------
   Раньше расшифровка шла через внешний сервис (Hugging Face Inference
   API, модель Whisper) — отдельный сервер-провайдер, токен доступа,
   зависимость от чужой инфраструктуры и её доступности/лимитов. Мессенджер
   должен уметь работать сам по себе, без сторонних сервисов — а слабому
   серверу ещё и незачем самому гонять модель распознавания речи.
   Поэтому расшифровка теперь делается СРАЗУ, ВО ВРЕМЯ записи голосового/
   кружка — прямо в браузере отправителя, встроенным Web Speech API
   (window.SpeechRecognition), который слушает тот же микрофон, что и
   MediaRecorder, параллельно с записью самого аудио/видео. Готовый текст
   уезжает вместе с сообщением как m.meta.transcript — сервер его просто
   хранит как есть, никаких HTTP-запросов "наружу" и никакой обработки на
   сервере не требуется вообще.
   Раньше похожая идея (Web Speech API) уже пробовалась, но иначе: чтобы
   расшифровать уже готовую запись, звук приходилось заново проигрывать
   через динамики и слушать микрофоном — отсюда и нестабильность. Слушать
   живой микрофон прямо во время записи — штатный сценарий этого API,
   поэтому и работает предсказуемо. Плата за это: расшифровать можно
   только то, что записано ПОСЛЕ этого изменения, и только если браузер
   отправителя поддерживает Web Speech API (это встроено в Chrome/Chromium
   и большинство Android-браузеров; Safari/Firefox поддерживают частично
   или не поддерживают — тогда голосовое/кружок всё равно отправляются,
   просто без готового текста). */

// Запускает распознавание речи параллельно с MediaRecorder. Возвращает
// null, если API не поддерживается браузером (штатный случай — тогда
// сообщение просто уйдёт без транскрипта). Ошибки самого распознавания
// (нет речи, глюк движка и т.п.) проглатываются — на запись голосового
// это не должно влиять никак.
function startLiveTranscription() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  let rec;
  try {
    rec = new SR();
    rec.lang = (navigator.language || 'ru-RU');
    rec.continuous = true;
    rec.interimResults = false;
  } catch (e) { return null; }
  let finalText = '';
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        const chunk = (e.results[i][0].transcript || '').trim();
        if (chunk) finalText += (finalText ? ' ' : '') + chunk;
      }
    }
  };
  rec.onerror = () => {};
  try { rec.start(); } catch (e) { return null; }
  return {
    // Останавливает распознавание и отдаёт накопленный текст. Дожидаемся
    // события 'end', а не отдаём finalText сразу по вызову stop() — движок
    // ещё немного донакапливает финальный кусок последней фразы уже ПОСЛЕ
    // команды остановки. На случай, если 'end' по какой-то причине не
    // придёт (баг конкретного браузера), не блокируем отправку сообщения
    // дольше 1.5 сек.
    stop() {
      return new Promise((resolve) => {
        let done = false;
        const finish = () => { if (done) return; done = true; resolve(finalText.trim()); };
        rec.onend = finish;
        try { rec.stop(); } catch (e) { finish(); }
        setTimeout(finish, 1500);
      });
    },
  };
}

// Выводит уже готовый (пришедший вместе с сообщением) текст расшифровки
// прямо под медиа внутри пузыря. Повторный тап по кнопке сворачивает его
// обратно — сетевых запросов тут нет вообще, поэтому и крутилки/задержки
// не нужны.
function showTranscriptResult(bubble, anchorSelector, text) {
  let box = bubble.querySelector('.transcript-box');
  if (box) { box.classList.toggle('hidden'); return; }
  box = document.createElement('div');
  box.className = 'transcript-box';
  const anchor = bubble.querySelector(anchorSelector);
  if (anchor && anchor.parentNode) anchor.insertAdjacentElement('afterend', box);
  else bubble.appendChild(box);
  box.textContent = text || 'Речь не распознана';
}

function transcribeBtnClickHandler(bubble, anchorSelector, m) {
  return (e) => {
    e.stopPropagation();
    const text = m.meta && m.meta.transcript;
    if (!text) {
      showToast('Для этого сообщения нет расшифровки: она делается только во время записи и только если браузер отправителя её поддерживает');
      return;
    }
    showTranscriptResult(bubble, anchorSelector, text);
  };
}

function setupCircleVideoPlayer(bubble, m) {
  const wrap = bubble.querySelector('.circle-video-wrap');
  if (!wrap) return;
  const video = wrap.querySelector('.circle-video');
  const progressBar = wrap.querySelector('.circle-progress-bar');
  const muteBtn = wrap.querySelector('.circle-mute-btn');
  const toTextBtn = wrap.querySelector('.circle-totext-btn');
  const elapsedEl = wrap.querySelector('.circle-elapsed');

  const RADIUS = 47;
  const CIRC = 2 * Math.PI * RADIUS;
  progressBar.style.strokeDasharray = String(CIRC);
  progressBar.style.strokeDashoffset = String(CIRC);

  const fmtDuration = (t) => {
    if (!isFinite(t) || t < 0) t = 0;
    const mm = Math.floor(t / 60);
    const ss = Math.floor(t % 60);
    return `${mm}:${String(ss).padStart(2, '0')}`;
  };

  const updateProgress = () => {
    const dur = video.duration || 0;
    const pct = dur ? Math.min(1, video.currentTime / dur) : 0;
    progressBar.style.strokeDashoffset = String(CIRC * (1 - pct));
    elapsedEl.textContent = fmtDuration(video.currentTime);
  };

  const BASE_SIZE = 160; // должен совпадать с шириной/высотой .circle-video-wrap в CSS
  const EXPANDED_SCALE = 1.32;
  const EXPAND_MARGIN = 10; // минимальный отступ от края видимой области чата

  // ВАЖНО: раньше position:fixed ставился только на .circle-video-wrap.
  // Плашка со временем отправки/статусом прочтения (.media-time-overlay)
  // лежит не внутри wrap, а рядом с ним, прямо в .bubble — поэтому она
  // оставалась в старом (маленьком, ещё в потоке) месте, пока сам кружок
  // улетал в новую точку экрана. Теперь fixed-позиционируем весь .bubble
  // целиком — тогда все его дети (и wrap, и плашка времени) двигаются
  // одним куском и никогда не расходятся.
  const messagesEl = $('#messages');

  const getBounds = () => {
    const r = messagesEl.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  };

  const repositionExpanded = () => {
    if (!bubble.classList.contains('circle-bubble-expanded') || !bubble._circleAnchor) return;
    const targetSize = BASE_SIZE * EXPANDED_SCALE;
    const { cx, cy } = bubble._circleAnchor;
    const b = getBounds();
    const maxLeft = Math.max(b.left + EXPAND_MARGIN, b.right - EXPAND_MARGIN - targetSize);
    const maxTop = Math.max(b.top + EXPAND_MARGIN, b.bottom - EXPAND_MARGIN - targetSize);
    const left = Math.min(Math.max(cx - targetSize / 2, b.left + EXPAND_MARGIN), maxLeft);
    const top = Math.min(Math.max(cy - targetSize / 2, b.top + EXPAND_MARGIN), maxTop);
    bubble.style.left = left + 'px';
    bubble.style.top = top + 'px';
    bubble.style.width = targetSize + 'px';
    bubble.style.height = targetSize + 'px';
  };

  const collapse = () => {
    if (activeExpandedCircle && activeExpandedCircle.bubble === bubble) activeExpandedCircle = null;
    window.removeEventListener('resize', repositionExpanded);
    wrap.classList.remove('expanded');
    bubble.classList.remove('circle-bubble-expanded');
    bubble.style.position = ''; bubble.style.left = ''; bubble.style.top = '';
    bubble.style.width = ''; bubble.style.height = ''; bubble.style.margin = ''; bubble.style.zIndex = '';
    bubble._circleAnchor = null;
    // Если при разворачивании мы искусственно проскроллили ленту вниз
    // (см. isLastRow-ветку в expand()), теперь откатываем это обратно.
    // БАГ: раньше сперва удалялась заглушка (лента становилась короче, и
    // браузер САМ подрезал scrollTop до нового максимума), а потом поверх
    // этого ещё раз откручивали на -delta — получалась двойная
    // компенсация, и лента уезжала вверх/дёргалась. Теперь scrollTop
    // выставляется один раз, абсолютным значением, под защитой от
    // собственного scroll-события.
    const hadScrollDelta = bubble._circleScrollDelta || 0;
    const scrollBefore = messagesEl.scrollTop;
    if (bubble._circlePlaceholder) { bubble._circlePlaceholder.remove(); bubble._circlePlaceholder = null; }
    if (hadScrollDelta) {
      circleAutoScrollDepth++;
      messagesEl.scrollTop = Math.max(0, scrollBefore - hadScrollDelta);
      setTimeout(() => { circleAutoScrollDepth--; }, 150);
      bubble._circleScrollDelta = 0;
    }
    video.muted = true;
    muteBtn.style.display = '';
    muteBtn.textContent = '🔇';
  };
  const expand = () => {
    // Одновременно может быть развёрнут только один кружок.
    if (activeExpandedCircle && activeExpandedCircle.collapse) activeExpandedCircle.collapse();
    const rect = bubble.getBoundingClientRect();
    const targetSize = BASE_SIZE * EXPANDED_SCALE;
    // Заглушка встаёт на место пузыря в потоке сообщений — но уже РАЗМЕРОМ
    // увеличенного кружка (а не исходного маленького), поэтому соседние
    // сообщения физически подвигаются и освобождают место, а не остаются
    // на месте под увеличенным кружком, который их перекрывает.
    const placeholder = document.createElement('div');
    placeholder.className = 'circle-bubble-placeholder';
    placeholder.style.width = targetSize + 'px';
    placeholder.style.height = targetSize + 'px';
    bubble.parentNode.insertBefore(placeholder, bubble);
    bubble._circlePlaceholder = placeholder;

    // Обычно рост заглушки раздвигает сообщения, идущие ПОСЛЕ нашего —
    // это обычный document flow. Но если наше сообщение последнее в
    // ленте (после него ничего нет), раздвигать нечего, и визуально
    // ничего не двигалось. В этом случае вместо раздвигания следующих
    // компенсируем прирост высоты прокруткой ленты вниз на ту же
    // величину — тогда вместо отсутствующих "следующих" сообщений
    // вверх уезжают предыдущие, ровно как просил пользователь.
    const row = bubble.parentNode;
    const isLastRow = row && row.parentNode === messagesEl && messagesEl.lastElementChild === row;
    bubble._circleScrollDelta = 0;
    if (isLastRow) {
      const deltaHeight = targetSize - rect.height;
      if (deltaHeight > 0) {
        bubble._circleScrollDelta = deltaHeight;
        animateMessagesScroll(messagesEl, deltaHeight, 250);
      }
    }

    bubble.style.position = 'fixed';
    bubble.style.left = rect.left + 'px';
    bubble.style.top = rect.top + 'px';
    bubble.style.width = rect.width + 'px';
    bubble.style.height = rect.height + 'px';
    bubble.style.margin = '0';
    bubble.style.zIndex = '30';
    void bubble.offsetWidth; // форсируем рефлоу перед стартом transition
    // Якорь берём уже ПОСЛЕ того, как заглушка подвинула соседние сообщения —
    // так увеличенный кружок разворачивается ровно на месте заглушки, а не
    // там, где маленький кружок был до того, как всё вокруг сдвинулось.
    const phRect = placeholder.getBoundingClientRect();
    // Если запущена компенсирующая прокрутка (isLastRow-ветка выше), она
    // ещё не доехала до конца в момент этого замера (едет плавно через
    // rAF), поэтому заранее целимся туда, где заглушка окажется, когда
    // скролл на bubble._circleScrollDelta px долистает до конца.
    bubble._circleAnchor = {
      cx: phRect.left + phRect.width / 2,
      cy: phRect.top + phRect.height / 2 - bubble._circleScrollDelta,
    };
    bubble.classList.add('circle-bubble-expanded');
    wrap.classList.add('expanded');
    video.muted = false;
    muteBtn.style.display = 'none';
    requestAnimationFrame(repositionExpanded);
    window.addEventListener('resize', repositionExpanded);
    activeExpandedCircle = { bubble, collapse };
  };
  const togglePlay = () => {
    if (video.paused) { video.play().catch(() => {}); expand(); }
    else { video.pause(); collapse(); }
  };

  video.addEventListener('timeupdate', updateProgress);
  video.addEventListener('loadedmetadata', updateProgress);
  video.addEventListener('ended', () => { collapse(); video.currentTime = 0; updateProgress(); });
  video.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });

  muteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    video.muted = !video.muted;
    muteBtn.textContent = video.muted ? '🔇' : '🔊';
  });

  toTextBtn.addEventListener('click', transcribeBtnClickHandler(bubble, '.circle-video-wrap', m));
}

function openMsgContextMenu(bubble, row, m) {
  const rect = bubble.getBoundingClientRect();
  const overlay = $('#msgContextOverlay');
  const cloneWrap = $('#msgContextCloneWrap');
  const menu = $('#msgContextMenu');

  // клон сообщения остаётся резким поверх размытого фона
  cloneWrap.innerHTML = '';
  const clone = bubble.cloneNode(true);
  // Фон пузыря задаётся селектором ".msg-row.mine .bubble" /
  // ".msg-row:not(.mine) .bubble" — то есть завязан на класс РОДИТЕЛЯ
  // (своё/чужое сообщение), а не самого .bubble. У cloneWrap такого
  // родителя не было, поэтому клон оставался без фона — виден текст и
  // реакции, а самого "пузыря" за ними не было. Переносим на cloneWrap
  // класс "mine" (или его отсутствие) из оригинальной строки, чтобы те же
  // CSS-правила сработали и здесь.
  cloneWrap.classList.toggle('mine', row.classList.contains('mine'));
  // Важно: без этого max-width:60% у .bubble применяется ПОВТОРНО уже
  // относительно ширины обёртки (которая и так равна исходной ширине
  // пузыря) — пузырь схлопывался до 60% от самого себя, текст и реакции
  // вылезали за края. Фиксируем точные размеры и снимаем ограничение.
  clone.style.maxWidth = 'none';
  clone.style.width = rect.width + 'px';
  clone.style.minHeight = rect.height + 'px';
  clone.style.boxSizing = 'border-box';
  cloneWrap.appendChild(clone);
  cloneWrap.style.left = rect.left + 'px';
  cloneWrap.style.top = rect.top + 'px';
  cloneWrap.style.width = rect.width + 'px';

  const reactionsEl = $('#msgContextReactions');
  reactionsEl.innerHTML = '';
  renderReactionButtons(reactionsEl, m.id, () => closeMsgContextMenu());
  reactionsEl.classList.toggle('hidden', !reactionsEl.children.length);

  const actionsEl = $('#msgContextActions');
  actionsEl.innerHTML = '';
  const conv = state.conversations.find((c) => c.id === state.activeConvId);

  const replyBtn = document.createElement('button');
  replyBtn.textContent = '↩️ Ответить';
  replyBtn.addEventListener('click', () => { closeMsgContextMenu(); startReply(m); });
  actionsEl.appendChild(replyBtn);

  const forwardBtn = document.createElement('button');
  forwardBtn.textContent = '↪️ Переслать';
  forwardBtn.addEventListener('click', () => { closeMsgContextMenu(); openForwardPicker(m); });
  actionsEl.appendChild(forwardBtn);

  if (m.msgType === 'text') {
    const copyBtn = document.createElement('button');
    copyBtn.textContent = '📋 Копировать';
    copyBtn.addEventListener('click', () => { closeMsgContextMenu(); copyMessageText(m); });
    actionsEl.appendChild(copyBtn);
  }

  if (canPinInConversation(conv)) {
    const isPinnedNow = conv && conv.pinnedMessage && conv.pinnedMessage.id === m.id;
    const pinBtn = document.createElement('button');
    pinBtn.textContent = isPinnedNow ? '📌 Открепить' : '📌 Закрепить';
    pinBtn.addEventListener('click', () => { closeMsgContextMenu(); togglePinMessage(conv.id, isPinnedNow ? null : m.id); });
    actionsEl.appendChild(pinBtn);
  }
  const isMine = m.senderId === state.user.id;
  if (isMine && m.msgType === 'text' && !m.forwardFrom) {
    const editBtn = document.createElement('button');
    editBtn.textContent = '✏️ Изменить';
    editBtn.addEventListener('click', () => { closeMsgContextMenu(); startEditMessage(row, m); });
    actionsEl.appendChild(editBtn);
  }
  if (isMine || state.user.isAdmin || convPerm(conv, 'deleteMessages')) {
    const delBtn = document.createElement('button');
    delBtn.textContent = '🗑 Удалить';
    delBtn.className = 'danger';
    delBtn.addEventListener('click', () => { closeMsgContextMenu(); deleteMessage(m.id); });
    actionsEl.appendChild(delBtn);
  }

  overlay.classList.remove('hidden');

  requestAnimationFrame(() => {
    const menuW = menu.offsetWidth, menuH = menu.offsetHeight;
    let top = rect.bottom + 10;
    if (top + menuH > window.innerHeight - 10) top = Math.max(10, rect.top - menuH - 10);
    let left = m.senderId === state.user.id ? rect.right - menuW : rect.left;
    left = Math.max(10, Math.min(left, window.innerWidth - menuW - 10));
    menu.style.top = top + 'px';
    menu.style.left = left + 'px';
  });
}

function closeMsgContextMenu() {
  $('#msgContextOverlay').classList.add('hidden');
}
$('#msgContextOverlay').addEventListener('click', (e) => {
  if (e.target === $('#msgContextOverlay')) closeMsgContextMenu();
});

// Ищет пользователя среди уже известных данных (личные чаты, кеш) — без похода
// на сервер. Используется для быстрого показа имени там, где это возможно.
function findKnownUser(userId) {
  const conv = state.conversations.find((c) => c.peer && c.peer.id === userId);
  if (conv) return conv.peer;
  return state.usersById[userId] || null;
}

// БАГ: на экране 1-на-1 звонка (входящий/исходящий/во время разговора)
// имя показывалось через user.displayName напрямую — сам объект
// conv.peer (который и возвращает findKnownUser) НЕ содержит локально
// установленный никнейм контакта: он лежит либо на самой беседе
// (conv.peerNickname — см. server.js /api/conversations), либо на объекте
// пользователя, отдельно загруженном через /api/users/:id
// (user.contactNickname). Из-за этого локальное имя контакта не
// применялось на звонках, даже если оно применялось везде в чатах.
function peerDisplayName(userId, fallbackUser) {
  const conv = state.conversations.find((c) => c.peer && c.peer.id === userId);
  if (conv && conv.peerNickname) return conv.peerNickname;
  const u = fallbackUser || (conv && conv.peer) || state.usersById[userId];
  return (u && (u.contactNickname || u.displayName)) || 'Собеседник';
}

function senderIsKnown(senderId) {
  if (senderId === state.user.id) return true;
  const conv = state.conversations.find((c) => c.id === state.activeConvId);
  if (conv && conv.peer && conv.peer.id === senderId) return true;
  return !!state.usersById[senderId];
}

function senderLabel(senderId) {
  if (senderId === state.user.id) return state.user.displayName;
  const conv = state.conversations.find((c) => c.id === state.activeConvId);
  if (conv && conv.peer && conv.peer.id === senderId) return conv.peer.displayName;
  const u = state.usersById[senderId];
  return u ? u.displayName : 'Пользователь';
}

/* ---------------- MESSAGE EDIT / DELETE ---------------- */

function startEditMessage(row, m) {
  const bubble = row.querySelector('.bubble');
  const original = bubble.innerHTML;
  bubble.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'msg-edit-box';
  box.innerHTML = `<textarea>${escapeHtml(m.content)}</textarea><div class="msg-edit-actions"><button class="btn-secondary" data-act="cancel">Отмена</button><button class="btn-primary" data-act="save">Сохранить</button></div>`;
  bubble.appendChild(box);
  const textarea = box.querySelector('textarea');
  textarea.focus();
  box.querySelector('[data-act="cancel"]').addEventListener('click', () => renderMessages());
  box.querySelector('[data-act="save"]').addEventListener('click', async () => {
    const content = textarea.value.trim();
    if (!content) return;
    try {
      await api(`/api/messages/${m.id}`, { method: 'PATCH', body: { content } });
    } catch (err) { alert(err.message); }
  });
}

async function deleteMessage(id) {
  if (!confirm('Удалить это сообщение?')) return;
  try {
    await api(`/api/messages/${id}`, { method: 'DELETE' });
  } catch (err) { alert(err.message); }
}

/* ---------------- REACTIONS ---------------- */

// Состояние анимации реакций: pending — реакция, которую только что поставили
// МЫ (ждём ответ сервера и после перерисовки запускаем салют). У других
// участников чата анимации нет.
const reactionFx = { pending: null };

// Набор реакций, доступных в чате: в каналах/группах владелец и админы могут
// его ограничить (conv.allowedReactions: null — все, массив — только эти).
function allowedReactionsFor(conv) {
  if (conv && (conv.type === 'channel' || conv.type === 'group') && Array.isArray(conv.allowedReactions)) {
    return REACTIONS.filter((e) => conv.allowedReactions.includes(e));
  }
  return REACTIONS;
}

function sendReaction(messageId, emoji) {
  if (!state.ws || state.ws.readyState !== 1) return;
  const list = state.messages[state.activeConvId] || [];
  const m = list.find((mm) => mm.id === messageId);
  const alreadyMine = !!(m && m.reactions && (m.reactions[emoji] || []).includes(state.user.id));
  // Ставим (а не снимаем) реакцию — запоминаем, чтобы проиграть анимацию,
  // как только сервер подтвердит и сообщение перерисуется.
  if (!alreadyMine) reactionFx.pending = { messageId, emoji, at: Date.now() };
  state.ws.send(JSON.stringify({ type: 'reaction', messageId, emoji }));
  $('#reactionPicker').classList.add('hidden');
}

// Салют из эмодзи: кольцо-волна, крупный эмодзи, всплывающий вверх, и россыпь
// маленьких частиц, разлетающихся веером из плашки реакции.
function playReactionBurst(anchor, emoji) {
  try { if (navigator.vibrate) navigator.vibrate(12); } catch (_) { /* не критично */ }
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const rect = anchor.getBoundingClientRect();
  if (!rect.width && !rect.height) return;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  let layer = document.getElementById('reactionBurstLayer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'reactionBurstLayer';
    layer.className = 'reaction-burst-layer';
    document.body.appendChild(layer);
  }
  const burst = document.createElement('div');
  burst.className = 'reaction-burst';
  burst.style.left = cx + 'px';
  burst.style.top = cy + 'px';
  const ring = document.createElement('span');
  ring.className = 'reaction-burst-ring';
  burst.appendChild(ring);
  const big = document.createElement('span');
  big.className = 'reaction-burst-big';
  big.textContent = emoji;
  burst.appendChild(big);
  const sparks = ['✨', '✨', '⭐'];
  const count = 14;
  for (let i = 0; i < count; i += 1) {
    const p = document.createElement('span');
    p.className = 'reaction-burst-particle';
    // веер, смещённый вверх: от -160° до -20° относительно оси X
    const angle = (-Math.PI * (0.1 + 0.8 * Math.random())) + (Math.random() - 0.5) * 0.4;
    const dist = 55 + Math.random() * 95;
    p.style.setProperty('--dx', Math.round(Math.cos(angle) * dist) + 'px');
    p.style.setProperty('--dy', Math.round(Math.sin(angle) * dist - 10) + 'px');
    p.style.setProperty('--rot', Math.round((Math.random() - 0.5) * 160) + 'deg');
    p.style.setProperty('--s', (0.7 + Math.random() * 0.9).toFixed(2));
    p.style.setProperty('--dur', Math.round(750 + Math.random() * 600) + 'ms');
    p.textContent = i % 4 === 3 ? sparks[i % sparks.length] : emoji;
    burst.appendChild(p);
  }
  layer.appendChild(burst);
  setTimeout(() => { burst.remove(); }, 1700);
}

// Рисует реакции, доступные в текущем чате (в каналах/группах набор может
// быть ограничен).
function renderReactionButtons(container, messageId, afterClick) {
  const conv = state.conversations.find((c) => c.id === state.activeConvId);
  allowedReactionsFor(conv).forEach((emoji) => {
    const b = document.createElement('button');
    b.textContent = emoji;
    b.addEventListener('click', () => { sendReaction(messageId, emoji); if (afterClick) afterClick(); });
    container.appendChild(b);
  });
}

function openReactionPicker(evt, messageId) {
  const picker = $('#reactionPicker');
  picker.innerHTML = '';
  renderReactionButtons(picker, messageId, null);
  const rect = evt.target.getBoundingClientRect();
  picker.style.top = (rect.top - 46 + window.scrollY) + 'px';
  picker.style.left = Math.max(8, rect.left - 100) + 'px';
  picker.classList.remove('hidden');
  evt.stopPropagation();
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#reactionPicker')) $('#reactionPicker').classList.add('hidden');
});

/* ---------------- LIGHTBOX ---------------- */

// src/type — для кнопки "Сохранить"; list/pos — плоский список всех
// фото/видео текущего чата (см. getChatMediaList) и позиция открытого
// элемента в нём, чтобы можно было листать стрелками/свайпом и показывать
// счётчик "N из M".
const lightboxState = { src: '', type: 'image', list: [], pos: -1 };

// Собирает плоский список всех фото/видео открытого чата в порядке
// переписки — обычные image/video сообщения как один элемент, альбомы
// (msgType 'album') разворачиваются на все свои плитки по отдельности.
// Список строится только из уже подгруженных сообщений (state.messages) —
// более старая история, ещё не подгруженная прокруткой вверх, в перелистывание
// не попадает.
function getChatMediaList() {
  const list = state.messages[state.activeConvId] || [];
  const media = [];
  list.forEach((m) => {
    if (m.msgType === 'image' || m.msgType === 'video') {
      media.push({ msgId: m.id, itemIdx: null, url: m.mediaUrl, type: m.msgType, name: (m.meta && m.meta.name) || '' });
    } else if (m.msgType === 'album' && m.meta && Array.isArray(m.meta.items)) {
      m.meta.items.forEach((it, idx) => {
        media.push({ msgId: m.id, itemIdx: idx, url: it.url, type: it.kind === 'video' ? 'video' : 'image', name: it.name || '' });
      });
    }
  });
  return media;
}

// msgId/itemIdx — координаты элемента внутри getChatMediaList(), нужны
// только чтобы найти начальную позицию для листания; сам показ идёт по src/type.
function openLightbox(src, type, msgId, itemIdx) {
  const list = getChatMediaList();
  const idx = itemIdx === undefined ? null : itemIdx;
  let pos = list.findIndex((it) => it.msgId === msgId && it.itemIdx === idx);
  if (pos === -1) pos = list.findIndex((it) => it.url === src); // на всякий случай, если координаты не совпали
  lightboxState.list = list;
  showLightboxAt(pos, { url: src, type });
}

// Полноэкранный предпросмотр аватара — свой или чужой профиль, канал/группа
// (см. клики по .my-avatar в openProfilePage/renderMyAvatar и по
// #channelInfoAvatar в openChannelPage). Переиспользуем обычный лайтбокс
// со скачиванием, просто как список из одного элемента — стрелки листания
// сами скрываются в updateLightboxNav, когда в списке меньше двух
// элементов, а меню "весь альбом" не появляется — getCurrentLightboxAlbumSiblings
// возвращает null для пустого списка.
function openAvatarLightbox(url) {
  if (!url) return;
  lightboxState.list = [];
  showLightboxAt(-1, { url, type: 'image' });
}

function showLightboxAt(pos, fallbackEntry) {
  const entry = (pos >= 0 && lightboxState.list[pos]) ? lightboxState.list[pos] : fallbackEntry;
  if (!entry) return;
  lightboxState.pos = pos >= 0 ? pos : -1;
  const src = entry.url || entry.src;
  const type = entry.type === 'video' ? 'video' : 'image';
  lightboxState.src = src;
  lightboxState.type = type;
  const img = $('#lightboxImg');
  const video = $('#lightboxVideo');
  if (type === 'video') {
    img.classList.add('hidden');
    img.src = '';
    video.src = src;
    video.muted = false;
    video.classList.remove('hidden');
    video.currentTime = 0;
    video.play().catch(() => {});
  } else {
    video.classList.add('hidden');
    video.pause();
    video.removeAttribute('src');
    video.load();
    img.classList.remove('hidden');
    img.src = src;
  }
  updateLightboxNav();
  $('#lightboxDownloadMenu').classList.add('hidden');
  $('#lightbox').classList.remove('hidden');
}

// Показывает/прячет счётчик "N из M" и стрелки в зависимости от того,
// сколько всего фото/видео в чате и на каком мы сейчас.
function updateLightboxNav() {
  const { list, pos } = lightboxState;
  const counter = $('#lightboxCounter');
  const prevBtn = $('#lightboxPrevBtn');
  const nextBtn = $('#lightboxNextBtn');
  if (list.length > 1 && pos >= 0) {
    counter.textContent = `${pos + 1} из ${list.length}`;
    counter.classList.remove('hidden');
    prevBtn.classList.toggle('hidden', pos <= 0);
    nextBtn.classList.toggle('hidden', pos >= list.length - 1);
  } else {
    counter.classList.add('hidden');
    prevBtn.classList.add('hidden');
    nextBtn.classList.add('hidden');
  }
}

function lightboxGoTo(delta) {
  const newPos = lightboxState.pos + delta;
  if (newPos < 0 || newPos >= lightboxState.list.length) return;
  showLightboxAt(newPos);
}

function closeLightbox() {
  $('#lightbox').classList.add('hidden');
  $('#lightboxDownloadMenu').classList.add('hidden');
  const video = $('#lightboxVideo');
  video.pause();
}
$('#lightboxClose').addEventListener('click', closeLightbox);
$('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') closeLightbox(); });
$('#lightboxPrevBtn').addEventListener('click', (e) => { e.stopPropagation(); lightboxGoTo(-1); });
$('#lightboxNextBtn').addEventListener('click', (e) => { e.stopPropagation(); lightboxGoTo(1); });
document.addEventListener('keydown', (e) => {
  if ($('#lightbox').classList.contains('hidden')) return;
  if (e.key === 'ArrowLeft') lightboxGoTo(-1);
  else if (e.key === 'ArrowRight') lightboxGoTo(1);
  else if (e.key === 'Escape') closeLightbox();
});

// Перелистывание свайпом влево/вправо на телефоне — свайп влево (палец
// движется справа налево) переключает на следующее медиа, вправо — на
// предыдущее, как в обычной галерее.
(() => {
  const lb = $('#lightbox');
  let sx = 0, sy = 0, tracking = false;
  lb.addEventListener('pointerdown', (e) => {
    // Не мешаем: кнопкам (закрыть/сохранить/стрелки) и нативным элементам
    // управления видео (там pointerdown нужен самому плееру для перемотки).
    if (e.target.closest('button') || e.target.tagName === 'VIDEO') return;
    tracking = true; sx = e.clientX; sy = e.clientY;
  });
  lb.addEventListener('pointerup', (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      lightboxGoTo(dx < 0 ? 1 : -1);
    }
  });
  lb.addEventListener('pointercancel', () => { tracking = false; });
})();

// Сохранение фото/видео из лайтбокса в ГАЛЕРЕЮ устройства.
//
// Раньше это делалось только через blob: URL + <a download> — и это в
// принципе не умеет класть файл в галерею НИГДЕ: обычный браузер (Safari
// на iPhone, Chrome/Samsung Internet на Android) в лучшем случае сохраняет
// такой файл в "Загрузки"/Files, а Safari на iOS вообще игнорирует атрибут
// download у медиафайлов. У веба просто нет прямого API "сохрани это в
// Фото" — единственный способ туда попасть с телефона это:
//   1) внутри нашего Android-приложения (обёртка apk) — нативный мост
//      WebAppInterface.downloadMedia() → системный DownloadManager, кладёт
//      файл прямо в Pictures/Movies с индексацией в галерею;
//   2) в обычном мобильном браузере (то, чем реально пользуются на
//      Samsung/iPhone, если открывают сайт, а не наше приложение) — Web
//      Share API с файлом (navigator.share({files:[...]})): и на iOS
//      Safari, и на Android Chrome/Samsung Internet это показывает
//      системный лист "Поделиться", где ЕСТЬ пункт "Сохранить
//      изображение"/"Сохранить видео" — единственный способ реально
//      положить файл в Фото/Галерею без нативного приложения;
//   3) если ничего из этого недоступно (десктоп) — старый способ через
//      blob-URL, там он работает и кладёт файл в Загрузки.
// Имя файла для сохранения. Раньше брали «всё после последней точки» из
// URL — и для адреса без точки (или с ?query) в имя попадал мусор, а
// исходное имя файла (его знает meta.name сообщения) терялось совсем: файл
// сохранялся как «asteria-photo-1731...». Теперь: исходное имя, если оно
// известно; иначе читаемое «Asteria photo 2026-11-11 14-05-33 (2).jpg».
function sanitizeFilename(name) {
  return String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim().slice(0, 150);
}
function mediaExtFromUrl(url, type) {
  let path = '';
  try { path = new URL(url, location.href).pathname; } catch (_) { path = String(url || ''); }
  const m = path.match(/\.([A-Za-z0-9]{1,5})$/);
  if (m) return m[1].toLowerCase();
  return type === 'video' ? 'mp4' : 'jpg';
}
function guessMediaFilename(url, type, idx, originalName) {
  const clean = sanitizeFilename(originalName);
  if (clean && /\.[A-Za-z0-9]{1,5}$/.test(clean)) return clean;
  const ext = mediaExtFromUrl(url, type);
  if (clean) return `${clean}.${ext}`;
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
  const suffix = idx === undefined ? '' : ` (${idx + 1})`;
  return `Asteria ${type === 'video' ? 'video' : 'photo'} ${stamp}${suffix}.${ext}`;
}

// Ссылка на файл из /uploads, которую сервер отдаст «как вложение» с
// исходным именем (см. ?dl=1&name= в serveStatic на сервере).
function uploadDownloadHref(url, filename) {
  const sep = String(url).includes('?') ? '&' : '?';
  return `${url}${sep}dl=1&name=${encodeURIComponent(filename || '')}`;
}

const mediaSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IS_MOBILE_BROWSER = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');

async function downloadMediaBatch(items) {
  const named = items.map((it, i) => ({
    ...it,
    filename: guessMediaFilename(it.url, it.type, items.length > 1 ? i : undefined, it.name),
  }));

  // 1) Нативная Android-обёртка — свой мост в системную загрузку.
  if (window.AsteriaNotify && typeof window.AsteriaNotify.downloadMedia === 'function') {
    // БАГ: it.url — относительный путь вида "/uploads/xxx.jpg", а DownloadManager
    // требует абсолютный http(s)-адрес. Приводим к абсолютному здесь, на
    // JS-стороне, где точно известен настоящий location.
    named.forEach((it) => {
      const absoluteUrl = new URL(it.url, location.href).href;
      window.AsteriaNotify.downloadMedia(absoluteUrl, it.filename, it.type === 'video' ? 'video/mp4' : 'image/jpeg');
    });
    return 'native';
  }

  // 2) Обычный браузер. БАГ «не скачивает альбом (фото) на сайте»: раньше для
  //    каждого файла делали <a target="_blank">.click() в цикле — браузер
  //    разрешает только первое такое окно/скачивание за один жест и глушит
  //    остальные как всплывающие окна, поэтому из альбома не сохранялось
  //    почти ничего. Теперь: сначала забираем файлы как blob.
  let files = null;
  try {
    files = await Promise.all(named.map(async (it) => {
      const res = await fetch(it.url, { credentials: 'include' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      return new File([blob], it.filename, { type: blob.type || (it.type === 'video' ? 'video/mp4' : 'image/jpeg') });
    }));
  } catch (e) {
    files = null;
  }

  // 2a) Телефон/планшет в обычном браузере: системный лист «Поделиться» —
  //     единственный путь «Сохранить в Фото/Галерею» без нативного приложения.
  if (files && IS_MOBILE_BROWSER && navigator.canShare && navigator.share) {
    try {
      if (navigator.canShare({ files })) {
        await navigator.share({ files });
        return 'shared';
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled'; // человек сам закрыл лист
      // другая ошибка (например, истёк жест пользователя) — пробуем обычное скачивание ниже
    }
  }

  // 2b) Обычное скачивание: по одному файлу, с небольшой паузой — иначе
  //     Chrome/Safari принимают только первый.
  for (let i = 0; i < named.length; i++) {
    const it = named[i];
    const a = document.createElement('a');
    let objectUrl = null;
    if (files) {
      objectUrl = URL.createObjectURL(files[i]);
      a.href = objectUrl;
    } else {
      a.href = uploadDownloadHref(it.url, it.filename); // сервер отдаст как вложение с нужным именем
    }
    a.download = it.filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
    if (i < named.length - 1) await mediaSleep(400);
  }
  return 'saved';
}

async function downloadCurrentLightboxMedia() {
  const { src, type } = lightboxState;
  if (!src) return;
  const btn = $('#lightboxDownloadBtn');
  btn.classList.add('downloading');
  try {
    const { list, pos } = lightboxState;
    const cur = pos >= 0 ? list[pos] : null;
    const result = await downloadMediaBatch([{ url: src, type, name: cur && cur.name }]);
    if (result === 'native') showToast('Загрузка начата');
  } catch (e) {
    showToast('Не удалось сохранить файл');
  } finally {
    btn.classList.remove('downloading');
  }
}

// Все элементы того же альбома (тот же msgId), что и текущий открытый —
// для варианта "скачать весь альбом" в меню кнопки загрузки.
function getCurrentLightboxAlbumSiblings() {
  const { list, pos } = lightboxState;
  const current = list[pos];
  if (!current || current.itemIdx === null || current.itemIdx === undefined) return null;
  const siblings = list.filter((it) => it.msgId === current.msgId);
  return siblings.length > 1 ? siblings : null;
}

async function downloadWholeLightboxAlbum() {
  const siblings = getCurrentLightboxAlbumSiblings();
  if (!siblings) return;
  const btn = $('#lightboxDownloadBtn');
  btn.classList.add('downloading');
  try {
    // Одним вызовом с массивом файлов сразу — и для нативного моста (там
    // просто параллельно ставятся несколько загрузок в DownloadManager),
    // и для Web Share API (там это один системный лист "Поделиться" сразу
    // со всеми фото/видео альбома, а не по одному диалогу на файл).
    const result = await downloadMediaBatch(siblings);
    if (result === 'native') showToast('Загрузка альбома начата');
    else if (result === 'saved') showToast('Альбом сохранён');
  } catch (e) {
    showToast('Не удалось сохранить альбом');
  } finally {
    btn.classList.remove('downloading');
  }
}

$('#lightboxDownloadBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('#lightboxDownloadMenu');
  const siblings = getCurrentLightboxAlbumSiblings();
  if (!siblings) { downloadCurrentLightboxMedia(); return; }
  // Текущее фото/видео — часть альбома: спрашиваем, что именно сохранить,
  // а не тащим сразу весь альбом по одному клику.
  menu.classList.toggle('hidden');
});
$('#lightboxDownloadMenu').addEventListener('click', (e) => {
  e.stopPropagation();
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  $('#lightboxDownloadMenu').classList.add('hidden');
  if (btn.dataset.mode === 'album') downloadWholeLightboxAlbum();
  else downloadCurrentLightboxMedia();
});
document.addEventListener('click', (e) => {
  const wrap = $('#lightboxDownloadWrap');
  if (wrap && !wrap.contains(e.target)) $('#lightboxDownloadMenu').classList.add('hidden');
});

/* ---------------- SEND MESSAGE ---------------- */

function sendWSMessage(msgType, content, mediaUrl, meta, opts) {
  const convId = (opts && opts.convId) || state.activeConvId;
  if (!convId) return;
  if (!state.ws || state.ws.readyState !== 1 || navigator.onLine === false) {
    // Нет связи с сервером (или браузер знает, что сети нет — сокет ещё может числиться открытым): если включён AirPin (mesh без интернета) — отдаём ему (см. public/airpin.js).
    const offlineReplyId = opts ? (opts.replyToId || null) : (state.replyingTo ? state.replyingTo.id : null);
    if (window.AirPin && window.AirPin.handleOfflineSend(convId, msgType, content, meta, offlineReplyId)) {
      if (!opts) cancelReply();
      return;
    }
    throw new Error('Нет соединения с сервером');
  }
  const replyToId = opts ? (opts.replyToId || null) : (state.replyingTo ? state.replyingTo.id : null);
  state.ws.send(JSON.stringify({
    type: 'message', conversationId: convId, msgType, content: content || '', mediaUrl: mediaUrl || null, meta: meta || null, replyToId,
  }));
  if (!opts) cancelReply();
}

$('#sendBtn').addEventListener('click', sendTextMessage);
// Enter теперь просто переносит строку (обычное поведение textarea) и НЕ отправляет
// сообщение. Отправка с клавиатуры — Ctrl+Enter / Cmd+Enter (или кнопка "➤").
$('#messageInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendTextMessage();
  }
});
$('#messageInput').addEventListener('input', () => {
  autoGrowMessageInput();
  updateSendOrRecordButton();
  if (state.activeConvId && state.ws && state.ws.readyState === 1) {
    state.ws.send(JSON.stringify({ type: 'typing', conversationId: state.activeConvId }));
  }
});

function autoGrowMessageInput() {
  const el = $('#messageInput');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 132) + 'px';
}

// Тот же авто-рост высоты, что и у основного поля ввода (autoGrowMessageInput),
// но переиспользуемый для полей подписи к фото/видео (.caption-input),
// которые раньше были однострочными input и не переносили длинный текст.
function autoGrowCaption(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 132) + 'px';
}

function currentMiniApp() {
  const conv = state.conversations.find((c) => c.id === state.activeConvId);
  return (conv && conv.peer && conv.peer.miniApp) ? conv.peer.miniApp : null;
}

function updateSendOrRecordButton() {
  const hasText = $('#messageInput').value.trim().length > 0;
  const miniApp = currentMiniApp();
  const showMiniAppBtn = !!miniApp && !hasText;
  // Пока поле ввода пустое и у бота подключено мини-приложение — вместо
  // круглых кнопок «прикрепить»/«стикеры»/«голосовое» показываем одну кнопку
  // мини-приложения. Как только начали печатать — всё возвращается к обычной
  // раскладке (стикеры/вложения остаются, голосовое сменяется отправкой).
  $('#miniAppBtn').classList.toggle('hidden', !showMiniAppBtn);
  $('#attachBtn').classList.toggle('hidden', showMiniAppBtn);
  $('#stickerBtn').classList.toggle('hidden', showMiniAppBtn);
  $('#sendBtn').classList.toggle('hidden', !hasText);
  $('#recordBtn').classList.toggle('hidden', hasText || showMiniAppBtn);
}

// На десктопе мини-приложения открываются в плавающих окнах (можно перетаскивать
// за шапку, менять размер, открыть несколько, закрыть крестиком). На телефоне —
// прежняя шторка на весь экран.
const isDesktopMini = () => window.matchMedia('(min-width: 861px) and (pointer: fine)').matches;
let miniWinZ = 4000, miniWinCount = 0;
function openMiniWindow(url, title) {
  const wins = document.querySelectorAll('.mini-window');
  for (const w of wins) { if (w.dataset.url === url) { w.style.zIndex = ++miniWinZ; return; } }
  const w = document.createElement('div');
  w.className = 'mini-window';
  w.dataset.url = url;
  const off = (miniWinCount++ % 6) * 28;
  const W = Math.min(420, window.innerWidth - 40), H = Math.min(680, window.innerHeight - 60);
  w.style.cssText = `width:${W}px;height:${H}px;left:${Math.max(10, (window.innerWidth - W) / 2 + off - 60)}px;top:${Math.max(10, (window.innerHeight - H) / 2 + off - 40)}px;z-index:${++miniWinZ}`;
  w.innerHTML = `<div class="mini-window-bar"><div class="mini-window-title"><img src="/assets/miniapp-icon.png" alt=""><span></span></div>
    <div class="mini-window-actions"><button type="button" class="mini-window-btn" data-act="max" title="Развернуть">▢</button><button type="button" class="mini-window-btn" data-act="close" title="Закрыть">✕</button></div></div>
    <iframe class="mini-window-frame" title=""></iframe><div class="mini-window-resize"></div>`;
  w.querySelector('.mini-window-title span').textContent = title || 'Мини-приложение';
  const frame = w.querySelector('iframe');
  frame.src = url;
  document.body.appendChild(w);
  const bar = w.querySelector('.mini-window-bar');
  const front = () => { w.style.zIndex = ++miniWinZ; };
  w.addEventListener('mousedown', front);
  const startDrag = (e, mode) => {
    if (e.button !== 0 || (mode === 'move' && e.target.closest('.mini-window-btn'))) return;
    if (w.classList.contains('max')) return;
    e.preventDefault(); front();
    const sx = e.clientX, sy = e.clientY, r = w.getBoundingClientRect();
    w.classList.add('dragging');
    const mv = (ev) => {
      if (mode === 'move') {
        w.style.left = Math.min(window.innerWidth - 80, Math.max(-r.width + 120, r.left + ev.clientX - sx)) + 'px';
        w.style.top = Math.min(window.innerHeight - 40, Math.max(0, r.top + ev.clientY - sy)) + 'px';
      } else {
        w.style.width = Math.max(320, r.width + ev.clientX - sx) + 'px';
        w.style.height = Math.max(300, r.height + ev.clientY - sy) + 'px';
      }
    };
    const up = () => { w.classList.remove('dragging'); document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  };
  bar.addEventListener('mousedown', (e) => startDrag(e, 'move'));
  w.querySelector('.mini-window-resize').addEventListener('mousedown', (e) => startDrag(e, 'resize'));
  bar.addEventListener('dblclick', (e) => { if (!e.target.closest('.mini-window-btn')) w.classList.toggle('max'); });
  w.querySelector('[data-act="max"]').addEventListener('click', () => w.classList.toggle('max'));
  w.querySelector('[data-act="close"]').addEventListener('click', () => { frame.src = 'about:blank'; w.remove(); });
}
function openMiniApp(url, title) {
  if (!url) return;
  if (isDesktopMini()) return openMiniWindow(url, title);
  $('#miniAppTitle').textContent = title || 'Мини-приложение';
  $('#miniAppFrame').src = url;
  $('#miniAppModal').classList.remove('hidden');
}
function closeMiniApp() {
  $('#miniAppModal').classList.add('hidden');
  $('#miniAppFrame').src = 'about:blank';
}
$('#miniAppBtn').addEventListener('click', () => {
  const miniApp = currentMiniApp();
  if (!miniApp) return;
  const conv = state.conversations.find((c) => c.id === state.activeConvId);
  openMiniApp(miniApp.url, conv && conv.peer ? conv.peer.displayName : 'Мини-приложение');
});
$('#miniAppCloseBtn').addEventListener('click', closeMiniApp);
$('#miniAppModal').addEventListener('click', (e) => { if (e.target.id === 'miniAppModal') closeMiniApp(); });

function sendTextMessage() {
  const input = $('#messageInput');
  const text = input.value.trim();
  if (!text || !state.activeConvId) return;
  sendWSMessage('text', text);
  input.value = '';
  autoGrowMessageInput();
  updateSendOrRecordButton();
}

/* ---------------- REPLY ---------------- */

function replyPreviewLabel(m) {
  if (m.msgType === 'text') return stripMessageFormatting(m.content);
  const map = { image: '🖼 Фото', video: '🎬 Видео', video_circle: '🎥 Видеосообщение', voice: '🎙 Голосовое сообщение', music: '🎵 Трек', file: '📄 Файл', sticker: '😊 Стикер', poll: '📊 ' + (m.content || 'Опрос'), location: '📍 Геолокация', album: '🖼 Альбом' };
  return map[m.msgType] || stripMessageFormatting(m.content) || '';
}

function startReply(m) {
  if (!m) return;
  state.replyingTo = m;
  renderReplyPreview();
  $('#messageInput').focus();
}

function cancelReply() {
  if (!state.replyingTo) return;
  state.replyingTo = null;
  renderReplyPreview();
}

function renderReplyPreview() {
  const bar = $('#replyPreviewBar');
  if (!bar) return;
  const m = state.replyingTo;
  bar.classList.toggle('hidden', !m);
  if (!m) return;
  const name = m.senderId === state.user.id ? state.user.displayName : senderLabel(m.senderId);
  $('#replyPreviewLabel').textContent = 'Ответ ' + name;
  $('#replyPreviewText').textContent = replyPreviewLabel(m);
  // миниатюра, если отвечаем на фото / альбом
  const thumb = $('#replyPreviewThumb');
  if (thumb) {
    let src = '';
    if (m.msgType === 'image' && m.mediaUrl) src = m.mediaUrl;
    else if (m.msgType === 'album' && m.meta && Array.isArray(m.meta.items)) {
      const first = m.meta.items.find((it) => it && it.kind !== 'video' && it.url);
      if (first) src = first.url;
    }
    if (src) thumb.src = src; else thumb.removeAttribute('src');
    thumb.classList.toggle('hidden', !src);
  }
}
const cancelReplyBtn = $('#cancelReplyBtn');
if (cancelReplyBtn) cancelReplyBtn.addEventListener('click', cancelReply);

// Прокручивает к сообщению с данным id и на секунду подсвечивает его —
// используется и по клику на цитату ответа, и по клику на плашку
// закреплённого сообщения. Если сообщение старше того, что уже подгружено в открытый чат (см. пагинацию
// сообщений — loadOlderMessages), сначала дозагружает историю постранично,
// пока не найдёт его или пока она не кончится.
async function scrollToMessage(id) {
  const convId = state.activeConvId;
  let row = document.querySelector(`.msg-row[data-msg-id="${id}"]`);
  let guard = 0; // защита от бесконечной подгрузки, если сообщение не нашлось вообще
  while (!row && convId === state.activeConvId && state.messagesHasMore[convId] && guard < 25) {
    guard++;
    await loadOlderMessages(convId);
    if (convId !== state.activeConvId) return;
    row = document.querySelector(`.msg-row[data-msg-id="${id}"]`);
  }
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.add('msg-highlight');
  setTimeout(() => row.classList.remove('msg-highlight'), 1200);
}

/* ---------------- COPY TEXT ---------------- */

function copyMessageText(m) {
  const text = m.msgType === 'text' ? m.content : replyPreviewLabel(m);
  if (!text) return;
  const done = () => showToast('Скопировано');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { /* игнорируем */ }
  document.body.removeChild(ta);
}

let toastTimeout = null;
function showToast(text) {
  let el = $('#asteriaToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'asteriaToast';
    el.className = 'asteria-toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('visible');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.classList.remove('visible'), 1600);
}

/* ---------------- ATTACHMENTS ---------------- */

// Скрепка открывает шторку «Прикрепить» (модальное окно поверх чата), а не
// выпадающую плашку. Фото и видео — один пункт: можно выбрать и то и другое сразу.
function openSheetModal(sel) {
  ['#attachModal', '#stickerModal'].forEach((id) => { if (id !== sel) $(id).classList.add('hidden'); });
  $('#formatMenu').classList.add('hidden');
  const el = showModal(sel);
  // Тап по затемнённому фону закрывает шторку (у обычных модалок этого нет).
  if (!el._backdropBound) {
    el._backdropBound = true;
    el.addEventListener('click', (e) => { if (e.target === el) el.classList.add('hidden'); });
  }
}
$('#attachBtn').addEventListener('click', () => openSheetModal('#attachModal'));
$all('#attachModal [data-kind]').forEach((btn) => {
  btn.addEventListener('click', () => {
    $('#attachModal').classList.add('hidden');
    const kind = btn.dataset.kind;
    if (kind === 'poll') { openPollCreateModal(); return; }
    if (kind === 'location') { sendLocationMessage(); return; }
    const map = { media: '#fileInputMedia', file: '#fileInputFile', music: '#fileInputMusic' };
    $(map[kind]).click();
  });
});

// ---------------- ГЕОЛОКАЦИЯ (карта — Яндекс.Карты) ----------------

// Запрашиваем текущие координаты через стандартный Geolocation API браузера
// и отправляем их как обычное сообщение с msgType:'location'. Само
// отображение (картинка карты + ссылка "открыть на карте") делает
// Яндекс.Карты — см. renderLocationBubble() ниже, без ключа API, публичный
// сервис статичных карт static-maps.yandex.ru.
function sendLocationMessage() {
  if (!state.activeConvId) return;
  if (!('geolocation' in navigator)) {
    showToast('Геолокация не поддерживается этим браузером');
    return;
  }
  showToast('Определяем местоположение…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      sendWSMessage('location', '', null, { lat, lng });
    },
    (err) => {
      const denied = err && err.code === err.PERMISSION_DENIED;
      showToast(denied
        ? 'Доступ к геолокации запрещён — разрешите его в настройках браузера'
        : 'Не удалось определить местоположение');
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

// Картинка-превью карты с меткой + ссылка на полноценные Яндекс.Карты по
// клику. lat/lng к этому моменту уже проверены и являются числами (либо на
// сервере при сохранении сообщения, либо здесь ещё раз на всякий случай —
// напрямую подставлять непроверенные значения в href/src нельзя).
function renderLocationBubble(m) {
  const lat = Number(m.meta && m.meta.lat);
  const lng = Number(m.meta && m.meta.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return `<div class="msg-text">📍 Геолокация недоступна</div>`;
  }
  const llParam = `${lng.toFixed(6)},${lat.toFixed(6)}`;
  const mapImg = `https://static-maps.yandex.ru/1.x/?ll=${llParam}&z=15&l=map&pt=${llParam},pm2rdm&size=450,300`;
  const mapLink = `https://yandex.ru/maps/?ll=${llParam}&z=16&pt=${llParam}`;
  return `<a class="location-bubble" href="${mapLink}" target="_blank" rel="noopener noreferrer">
    <img class="location-map-img" src="${mapImg}" alt="Геолокация на Яндекс.Картах" loading="lazy">
    <div class="location-caption">📍 Геолокация · открыть на Яндекс.Картах</div>
  </a>`;
}

/* ---------------- POLLS (опросы) ---------------- */

const POLL_MAX_OPTIONS = 12;
// БАГ (Samsung Galaxy, Samsung Keyboard в Chrome): текст в полях опроса
// набирался задом наперёд — каретка прыгала в начало после каждой буквы
// автокоррекции. Известная проблема этой клавиатуры с атрибутом maxlength на
// <input>. Поэтому maxlength у полей опроса не ставим, а лимит длины
// применяем при отправке (сервер всё равно режет до 120/300 символов).
const POLL_OPTION_MAX_LEN = 120;
const POLL_QUESTION_MAX_LEN = 300;
let pollOptionCount = 0;

function pollOptionRow(index, value) {
  const row = document.createElement('div');
  row.className = 'poll-option-row';
  row.dataset.index = index;
  row.innerHTML = `
    <input type="text" class="poll-option-input" placeholder="Вариант ${index + 1}" value="${escapeHtml(value || '')}" autocomplete="off" autocorrect="off" autocapitalize="sentences" spellcheck="false" enterkeyhint="next">
    <button type="button" class="poll-option-remove" title="Удалить вариант">✕</button>
  `;
  row.querySelector('.poll-option-remove').addEventListener('click', () => {
    row.remove();
    refreshPollOptionUI();
  });
  return row;
}

function refreshPollOptionUI() {
  const rows = $all('#pollOptionsList .poll-option-row');
  pollOptionCount = rows.length;
  // нельзя удалить меньше 2 вариантов
  rows.forEach((row) => {
    row.querySelector('.poll-option-remove').classList.toggle('hidden', rows.length <= 2);
  });
  $('#pollAddOptionBtn').classList.toggle('hidden', rows.length >= POLL_MAX_OPTIONS);

  // пересобираем список "максимум вариантов" под текущее число опций
  const select = $('#pollMaxChoicesSelect');
  const prevValue = select.value;
  select.innerHTML = '';
  for (let i = 2; i <= Math.max(2, rows.length); i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = i === rows.length ? `${i} (любой вариант из всех)` : String(i);
    select.appendChild(opt);
  }
  if ([...select.options].some((o) => o.value === prevValue)) select.value = prevValue;
}

function openPollCreateModal() {
  $('#pollQuestionInput').value = '';
  $('#pollError').textContent = '';
  $('#pollMultipleCheckbox').checked = false;
  $('#pollMaxChoicesRow').classList.add('hidden');
  const list = $('#pollOptionsList');
  list.innerHTML = '';
  list.appendChild(pollOptionRow(0));
  list.appendChild(pollOptionRow(1));
  refreshPollOptionUI();
  showModal('#pollCreateModal');
}

$('#pollAddOptionBtn').addEventListener('click', () => {
  const list = $('#pollOptionsList');
  const count = $all('#pollOptionsList .poll-option-row').length;
  if (count >= POLL_MAX_OPTIONS) return;
  list.appendChild(pollOptionRow(count));
  refreshPollOptionUI();
  list.lastElementChild.querySelector('input').focus();
});

$('#pollMultipleCheckbox').addEventListener('change', () => {
  $('#pollMaxChoicesRow').classList.toggle('hidden', !$('#pollMultipleCheckbox').checked);
});

$('#pollSendBtn').addEventListener('click', () => {
  $('#pollError').textContent = '';
  const question = $('#pollQuestionInput').value.trim().slice(0, POLL_QUESTION_MAX_LEN);
  if (!question) { $('#pollError').textContent = 'Введите вопрос'; return; }
  const options = $all('#pollOptionsList .poll-option-input')
    .map((inp) => inp.value.trim().slice(0, POLL_OPTION_MAX_LEN))
    .filter(Boolean);
  if (options.length < 2) { $('#pollError').textContent = 'Нужно минимум 2 варианта ответа'; return; }
  if (options.length > POLL_MAX_OPTIONS) { $('#pollError').textContent = `Максимум ${POLL_MAX_OPTIONS} вариантов`; return; }
  const multiple = $('#pollMultipleCheckbox').checked;
  const maxChoices = multiple ? parseInt($('#pollMaxChoicesSelect').value, 10) || options.length : 1;

  sendWSMessage('poll', question, null, {
    question,
    options: options.map((text) => ({ text })),
    maxChoices,
  });
  $('#pollCreateModal').classList.add('hidden');
});

function pollUserVotes(m) {
  const votes = (m.meta && m.meta.votes) || {};
  return Object.keys(votes).filter((optId) => votes[optId].includes(state.user.id));
}

function totalPollVoters(m) {
  const votes = (m.meta && m.meta.votes) || {};
  const uniq = new Set();
  Object.values(votes).forEach((arr) => arr.forEach((uid) => uniq.add(uid)));
  return uniq.size;
}

// Коллаж из нескольких фото/видео, отправленных одним альбомом (см.
// mediaBatchSendBtn ниже) — сетка плиток, каждая открывает лайтбокс с
// перелистыванием (data-item-idx хранит позицию внутри альбома).
function renderAlbumBubble(m) {
  const items = (m.meta && Array.isArray(m.meta.items)) ? m.meta.items : [];
  // Нечётный "хвостовой" элемент (3/5/7/9 фото) растягивается на всю ширину
  // сетки (см. .album-grid[data-count] .album-tile:last-child в CSS) — как
  // и одиночное фото/видео, он должен получить те же настройки отображения,
  // что и обычное медиа-сообщение: размытую увеличенную подложку сзади +
  // само изображение поверх неё (media-frame/media-frame-bg), а не просто
  // object-fit: cover, как у обычных плиток коллажа.
  const isTail = (idx) => items.length > 1 && items.length % 2 === 1 && idx === items.length - 1;
  let html = `<div class="album-grid" data-count="${items.length}">`;
  items.forEach((it, idx) => {
    const tail = isTail(idx);
    if (it.kind === 'video') {
      html += tail
        ? `<div class="album-tile album-tile-tail" data-lightbox="1" data-lightbox-type="video" data-item-idx="${idx}">
            <video class="media-frame-bg-video" src="${it.url}" muted playsinline preload="metadata"></video>
            <video class="media-frame-video-fg" src="${it.url}" muted playsinline preload="metadata"></video>
            <span class="album-video-badge">▶</span>
          </div>`
        : `<div class="album-tile" data-lightbox="1" data-lightbox-type="video" data-item-idx="${idx}">
            <video src="${it.url}" muted playsinline preload="metadata"></video>
            <span class="album-video-badge">▶</span>
          </div>`;
    } else {
      html += tail
        ? `<div class="album-tile album-tile-tail" data-lightbox="1" data-lightbox-type="image" data-item-idx="${idx}">
            <div class="media-frame-bg" style="background-image:url('${it.url}')"></div>
            <img class="media-frame-img" src="${it.url}" loading="lazy">
          </div>`
        : `<div class="album-tile" data-lightbox="1" data-lightbox-type="image" data-item-idx="${idx}">
            <img src="${it.url}" loading="lazy">
          </div>`;
    }
  });
  html += `</div>`;
  return html;
}

// Какие опросы раскрыты кнопкой «Показать голоса» (перерисовка сообщения их не сбрасывает).
const pollVotersShown = new Set();

function renderPollBubble(m) {
  const meta = m.meta || { options: [], votes: {}, maxChoices: 1 };
  const votes = meta.votes || {};
  const totalVoters = totalPollVoters(m);
  const mySelections = pollUserVotes(m);
  const multi = (meta.maxChoices || 1) > 1;
  const showVoters = pollVotersShown.has(m.id);

  let html = `<div class="poll-bubble">
    <div class="poll-question">${escapeHtml(meta.question || m.content)}</div>
    <div class="poll-hint"><svg class="poll-hint-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="8.5" cy="12" r="6.5"/><circle cx="15.5" cy="12" r="6.5"/><path d="M5.6 12.2l2 2 3.6-3.8M12.8 12.2l2 2 3.6-3.8" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${multi ? 'Выберите вариант(ы)' : 'Выберите вариант'}</span></div>`;

  meta.options.forEach((opt) => {
    const voters = votes[opt.id] || [];
    const count = voters.length;
    const pct = totalVoters ? Math.round((count / totalVoters) * 100) : 0;
    const mine = mySelections.includes(opt.id);
    const names = showVoters && count
      ? `<div class="poll-voters">${voters.map((uid) => (uid === state.user.id ? 'Вы' : escapeHtml(senderLabel(uid)))).join(', ')}</div>`
      : '';
    html += `
      <div class="poll-option${mine ? ' mine' : ''}" data-opt="${opt.id}">
        <span class="poll-radio${multi ? ' square' : ''}"></span>
        <div class="poll-option-body">
          <div class="poll-option-top">
            <span class="poll-option-text">${escapeHtml(opt.text)}</span>
            <span class="poll-option-count">${count}</span>
          </div>
          <div class="poll-bar"><div class="poll-bar-fill" style="width:${pct}%"></div></div>
          ${names}
        </div>
      </div>`;
  });
  html += '</div>';
  return html;
}

// Нижняя часть опроса: разделитель и кнопка «Показать голоса» на всю ширину пузыря.
function pollFooterHtml(m) {
  return `<button type="button" class="poll-show-votes" data-poll-toggle="1">${pollVotersShown.has(m.id) ? 'Скрыть голоса' : 'Показать голоса'}</button>`;
}

function pluralVotes(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'голос';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'голоса';
  return 'голосов';
}

function votePoll(messageId, optionId) {
  const list = state.messages[state.activeConvId] || [];
  const m = list.find((mm) => mm.id === messageId);
  if (!m) return;
  const meta = m.meta || {};
  const current = pollUserVotes(m);
  let next;
  if ((meta.maxChoices || 1) <= 1) {
    next = current.includes(optionId) ? [] : [optionId];
  } else if (current.includes(optionId)) {
    next = current.filter((id) => id !== optionId);
  } else {
    if (current.length >= meta.maxChoices) {
      alert(`Можно выбрать не более ${meta.maxChoices} вариантов`);
      return;
    }
    next = [...current, optionId];
  }
  state.ws.send(JSON.stringify({ type: 'poll-vote', messageId, optionIds: next }));
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// opts (необязательно): onProgress(0..1) — реальный прогресс отправки, onXhr(xhr) — чтобы можно было
// оборвать загрузку, isCancelled() — отмена ещё до начала отправки (пока файл читается).
async function uploadFile(file, kind, opts) {
  const dataBase64 = await fileToBase64(file);
  if (!opts) {
    const { url } = await api('/api/upload', { method: 'POST', body: { filename: file.name, dataBase64, kind } });
    return url;
  }
  const aborted = () => { const er = new Error('Отменено'); er.aborted = true; return er; };
  if (opts.isCancelled && opts.isCancelled()) throw aborted();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && opts.onProgress) opts.onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let d = {};
      try { d = JSON.parse(xhr.responseText); } catch (e) {}
      if (xhr.status >= 200 && xhr.status < 300 && d.url) resolve(d.url);
      else reject(new Error(d.error || 'Не удалось загрузить файл'));
    };
    xhr.onerror = () => reject(new Error('Нет соединения с сервером'));
    xhr.onabort = () => reject(aborted());
    if (opts.onXhr) opts.onXhr(xhr);
    xhr.send(JSON.stringify({ filename: file.name, dataBase64, kind }));
  });
}

/* ---------------- ВЛОЖЕНИЯ, КОТОРЫЕ ЕЩЁ ЗАГРУЖАЮТСЯ ----------------
   Сообщение появляется в ленте сразу (по локальной копии файла) с кольцом
   прогресса и кнопкой отмены; когда файл ушёл на сервер и сообщение отправлено —
   оно заменяется настоящим, которое пришло по WebSocket. */
const pendingByConv = {}; // convId -> [pending]
let pendingSeq = 0;
const PENDING_RING = 2 * Math.PI * 21;

function pendingList(convId) { return pendingByConv[convId] || (pendingByConv[convId] = []); }

function pendingFakeMessage(p) {
  return {
    id: 'pending-' + p.pid, conversationId: p.convId, senderId: state.user.id, msgType: p.msgType,
    content: p.content || '', mediaUrl: p.localUrl || null, meta: p.meta || null, createdAt: p.createdAt, reactions: {},
  };
}

function renderPendingRow(p) {
  const row = renderMessageBubble(pendingFakeMessage(p));
  row.classList.add('msg-pending', 'pending-' + p.msgType);
  row.dataset.pid = p.pid;
  const bubble = row.querySelector('.bubble');
  const inline = p.msgType === 'file' || p.msgType === 'music' || p.msgType === 'voice';
  const host = inline ? bubble : (bubble.querySelector('.media-frame, .album-grid, .circle-video-wrap') || bubble);
  const ov = document.createElement('div');
  ov.className = 'upload-overlay' + (inline ? ' inline' : '');
  ov.innerHTML = `<button type="button" class="upload-cancel" title="Отменить загрузку" aria-label="Отменить загрузку">
    <svg class="upload-ring" viewBox="0 0 48 48"><circle class="upload-ring-track" cx="24" cy="24" r="21"></circle><circle class="upload-ring-bar" cx="24" cy="24" r="21"></circle></svg>
    <span class="upload-stop"></span></button>`;
  host.appendChild(ov);
  applyPendingProgress(row, p);
  return row;
}

function applyPendingProgress(row, p) {
  const bar = row.querySelector('.upload-ring-bar');
  if (!bar) return;
  const f = Math.min(1, Math.max(0, p.progress || 0));
  bar.style.strokeDasharray = String(PENDING_RING);
  bar.style.strokeDashoffset = String(PENDING_RING * (1 - Math.max(f, 0.06)));
  row.classList.toggle('upload-indeterminate', f <= 0);
  row.classList.toggle('upload-sent', p.status === 'sent');
}

function setPendingProgress(p, f) {
  p.progress = f;
  const row = document.querySelector(`#messages .msg-row[data-pid="${p.pid}"]`);
  if (row) applyPendingProgress(row, p);
}

function showPendingRow(p) {
  if (state.activeConvId !== p.convId) return;
  const el = $('#messages');
  if (el.classList.contains('is-empty')) {
    el.classList.remove('is-empty');
    el.innerHTML = '';
    updateComposerVisibility(state.conversations.find((c) => c.id === state.activeConvId));
  }
  let row;
  try { row = renderPendingRow(p); } catch (e) { return; } // не удалось нарисовать превью — загрузка всё равно идёт
  row.classList.add('msg-enter');
  el.appendChild(row);
  el.scrollTop = el.scrollHeight;
  updateChatFogState();
}

function removePending(p) {
  const list = pendingList(p.convId);
  const i = list.indexOf(p);
  if (i >= 0) list.splice(i, 1);
  const row = document.querySelector(`#messages .msg-row[data-pid="${p.pid}"]`);
  if (row) row.remove();
  const urls = p.meta && Array.isArray(p.meta.items) ? p.meta.items.map((it) => it.url) : [p.localUrl];
  setTimeout(() => urls.forEach((u) => { if (u) { try { URL.revokeObjectURL(u); } catch (e) {} } }), 3000);
}

function cancelPending(p) {
  if (p.status !== 'uploading') return;
  p.cancelled = true;
  if (p.xhr) { try { p.xhr.abort(); } catch (e) {} }
  removePending(p);
}

// Настоящее сообщение пришло — убираем «ожидающую» копию (она уже в статусе sent).
function dropEchoedPending(convId, msgType) {
  const p = pendingList(convId).find((x) => x.status === 'sent' && x.msgType === msgType);
  if (p) removePending(p);
}

$('#messages').addEventListener('click', (e) => {
  const btn = e.target.closest('.upload-cancel');
  if (!btn) return;
  const row = btn.closest('.msg-row');
  const p = row && pendingList(state.activeConvId).find((x) => String(x.pid) === row.dataset.pid);
  if (p) cancelPending(p);
});

function newPending(extra) {
  const convId = state.activeConvId;
  const replyToId = state.replyingTo ? state.replyingTo.id : null;
  cancelReply();
  const p = Object.assign({
    pid: ++pendingSeq, convId, replyToId, progress: 0, status: 'uploading', cancelled: false, xhr: null,
    createdAt: Date.now(), localUrl: null, meta: null, content: '',
  }, extra);
  pendingList(convId).push(p);
  showPendingRow(p);
  return p;
}

function finishPendingSend(p, mediaUrl, meta, content) {
  p.status = 'sent';
  const row = document.querySelector(`#messages .msg-row[data-pid="${p.pid}"]`);
  if (row) applyPendingProgress(row, p);
  try {
    sendWSMessage(p.msgType, content || '', mediaUrl, meta, { convId: p.convId, replyToId: p.replyToId });
  } catch (e) { removePending(p); throw e; }
  setTimeout(() => { if (pendingList(p.convId).includes(p)) removePending(p); }, 20000);
}

// Один файл: сообщение сразу в ленте, загрузка идёт в фоне.
function sendFileWithPending(file, uploadKind, msgType, caption, metaOverride) {
  if (!state.activeConvId) return;
  const meta = metaOverride || { name: file.name, size: file.size, mime: file.type };
  const p = newPending({ msgType, content: caption || '', meta, localUrl: URL.createObjectURL(file) });
  uploadFile(file, uploadKind, {
    onProgress: (f) => setPendingProgress(p, f),
    onXhr: (x) => { p.xhr = x; },
    isCancelled: () => p.cancelled,
  }).then((url) => {
    if (p.cancelled) return;
    finishPendingSend(p, url, meta, caption || '');
  }).catch((err) => {
    if (p.cancelled || (err && err.aborted)) return;
    removePending(p);
    showToast(`Не удалось отправить «${file.name}»: ${(err && err.message) || 'ошибка'}`);
  });
}

// Несколько фото/видео: один альбом-«пузырь» с общим прогрессом.
function sendAlbumWithPending(entries, caption) {
  if (!state.activeConvId) return;
  const localItems = entries.map(({ file, kind }) => ({ url: URL.createObjectURL(file), kind, name: file.name, size: file.size, mime: file.type }));
  const p = newPending({ msgType: 'album', content: caption || '', meta: { items: localItems } });
  (async () => {
    const items = [];
    for (let i = 0; i < entries.length; i++) {
      if (p.cancelled) return;
      const { file, kind } = entries[i];
      try {
        const url = await uploadFile(file, kind, {
          onProgress: (f) => setPendingProgress(p, (i + f) / entries.length),
          onXhr: (x) => { p.xhr = x; },
          isCancelled: () => p.cancelled,
        });
        items.push({ url, kind, name: file.name, size: file.size, mime: file.type });
      } catch (err) {
        if (p.cancelled || (err && err.aborted)) return;
        showToast(`Не удалось отправить «${file.name}»`);
      }
    }
    if (p.cancelled) return;
    if (!items.length) { removePending(p); return; }
    if (items.length === 1) {
      const it = items[0];
      p.msgType = 'image' === it.kind || 'video' === it.kind ? it.kind : p.msgType;
      finishPendingSend(p, it.url, { name: it.name, size: it.size, mime: it.mime }, caption || '');
    } else finishPendingSend(p, null, { items }, caption || '');
  })().catch(() => removePending(p));
}

// Фото и видео — единый выбор. Одно фото — через предпросмотр с подписью;
// всё остальное (видео, несколько файлов, фото вместе с видео) — общая
// модалка мини-галереи, см. openMediaBatch. Тип определяется по каждому файлу.
function mediaKindOf(file) {
  if (file.type && file.type.startsWith('video/')) return 'video';
  if (file.type && file.type.startsWith('image/')) return 'image';
  if (/\.(mp4|mov|m4v|webm|mkv|3gp|avi)$/i.test(file.name || '')) return 'video';
  if (/\.(jpe?g|png|gif|webp|heic|heif|bmp|avif)$/i.test(file.name || '')) return 'image';
  return null;
}
$('#fileInputMedia').addEventListener('change', () => {
  const files = Array.from($('#fileInputMedia').files).filter((f) => mediaKindOf(f));
  $('#fileInputMedia').value = '';
  if (!files.length) { showToast('Выберите фото или видео'); return; }
  if (files.length === 1 && mediaKindOf(files[0]) === 'image') {
    state.pendingImageFile = files[0];
    $('#imagePreviewImg').src = URL.createObjectURL(files[0]);
    $('#imagePreviewCaption').value = '';
    $('#imagePreviewCaption').style.height = '';
    showModal('#imagePreviewModal');
    // autoGrow меряет scrollHeight, а у скрытого элемента (display:none до
    // showModal) он всегда 0 — отсюда "сплющенный" инпут до первого ввода.
    // Меряем ПОСЛЕ показа модалки.
    autoGrowCaption($('#imagePreviewCaption'));
  } else {
    openMediaBatch(files);
  }
});
$('#imagePreviewSendBtn').addEventListener('click', async () => {
  if (!state.pendingImageFile) return;
  const file = state.pendingImageFile;
  const caption = $('#imagePreviewCaption').value.trim();
  $('#imagePreviewModal').classList.add('hidden');
  state.pendingImageFile = null;
  sendFileWithPending(file, 'image', 'image', caption);
});
$('#imagePreviewCaption').addEventListener('input', () => autoGrowCaption($('#imagePreviewCaption')));

async function handleFileInput(inputEl, msgType) {
  inputEl.addEventListener('change', async () => {
    const files = inputEl.files;
    if (!files.length) return;
    // Видео/файлы/музыка — как и раньше, одиночный файл уходит сразу без
    // предпросмотра. Несколько видео разом (до 10) — та же общая модалка
    // мини-галереи, что и для фото; для файлов/музыки групповой выбор не
    // предусмотрен (там нет наглядного превью), отправляем только первый.
    const file = files[0];
    inputEl.value = '';
    sendFileWithPending(file, msgType, msgType, '');
  });
}
handleFileInput($('#fileInputFile'), 'file');
handleFileInput($('#fileInputMusic'), 'music');

/* ---------------- ОТПРАВКА НЕСКОЛЬКИХ ФОТО/ВИДЕО ЗА РАЗ (до 10) ---------------- */

const MAX_MEDIA_BATCH = 10;

// Открывает общую модалку-"мини-галерею" для отправки сразу нескольких
// фото или видео (можно выбрать в системном пикере несколько файлов —
// FileList — сразу; лишнее сверх лимита молча отбрасываем с тостом).
function openMediaBatch(fileList) {
  const all = Array.from(fileList);
  state.mediaBatchFiles = all.slice(0, MAX_MEDIA_BATCH).map((file) => ({ file, kind: mediaKindOf(file) || 'image' }));
  if (all.length > MAX_MEDIA_BATCH) showToast(`Можно отправить не больше ${MAX_MEDIA_BATCH} файлов за раз`);
  $('#mediaBatchCaption').value = '';
  $('#mediaBatchCaption').style.height = '';
  renderMediaBatchGrid();
  showModal('#mediaBatchModal');
  // Та же причина, что и у imagePreviewCaption: до showModal элемент скрыт,
  // scrollHeight === 0, поэтому измеряем высоту уже после показа модалки.
  autoGrowCaption($('#mediaBatchCaption'));
}
$('#mediaBatchCaption').addEventListener('input', () => autoGrowCaption($('#mediaBatchCaption')));

function renderMediaBatchGrid() {
  const grid = $('#mediaBatchGrid');
  grid.innerHTML = '';
  $('#mediaBatchCount').textContent = state.mediaBatchFiles.length ? `(${state.mediaBatchFiles.length})` : '';
  state.mediaBatchFiles.forEach((entry, idx) => {
    const item = document.createElement('div');
    item.className = 'media-batch-item';
    const url = URL.createObjectURL(entry.file);
    item.innerHTML = entry.kind === 'video' ? `<video src="${url}#t=0.1" playsinline preload="metadata"></video><span class="media-batch-play">▶</span>` : `<img src="${url}">`;
    // Встроенный просмотр: тап по видео проигрывает/ставит на паузу прямо в окне отправки.
    if (entry.kind === 'video') {
      const vid = item.querySelector('video'); const badge = item.querySelector('.media-batch-play');
      item.addEventListener('click', (e) => {
        if (e.target.closest('.media-batch-remove')) return;
        if (vid.paused) { grid.querySelectorAll('video').forEach((o) => { if (o !== vid) o.pause(); }); vid.play().catch(() => {}); } else vid.pause();
      });
      vid.addEventListener('play', () => { badge.style.display = 'none'; });
      vid.addEventListener('pause', () => { badge.style.display = ''; });
      vid.addEventListener('ended', () => { badge.style.display = ''; });
    }
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'media-batch-remove';
    rm.textContent = '✕';
    rm.title = 'Убрать';
    rm.addEventListener('click', () => {
      state.mediaBatchFiles.splice(idx, 1);
      if (!state.mediaBatchFiles.length) { $('#mediaBatchModal').classList.add('hidden'); return; }
      renderMediaBatchGrid();
    });
    item.appendChild(rm);
    grid.appendChild(item);
  });
}

$('#mediaBatchSendBtn').addEventListener('click', async () => {
  const entries = state.mediaBatchFiles.slice();
  if (!entries.length) return;
  const caption = $('#mediaBatchCaption').value.trim();
  $('#mediaBatchModal').classList.add('hidden');
  state.mediaBatchFiles = [];
  // Один файл — обычное фото/видео, несколько — один альбом-коллаж (как в Telegram).
  // Сообщение появляется в ленте сразу, пока файлы ещё загружаются.
  if (entries.length === 1) sendFileWithPending(entries[0].file, entries[0].kind, entries[0].kind, caption);
  else sendAlbumWithPending(entries, caption);
});

/* ---------------- ПЕРЕСЫЛКА СООБЩЕНИЙ ---------------- */

// Чаты, куда вообще можно что-то переслать: личные и групповые — всегда,
// каналы — только если я в них могу постить (владелец или админ сайта) —
// та же логика, что и в основном композере (см. canPostInConv).
function forwardableConversations() {
  return state.conversations.filter((c) => {
    if (c.type === 'dm') return true;
    if (c.type === 'group') return true;
    if (c.type === 'channel') return convPerm(c, 'post');
    return false;
  });
}

function openForwardPicker(m) {
  state.forwardMessage = m;
  state.shareDraft = null;
  $('#forwardModalTitleText').textContent = 'Переслать';
  $('#forwardSharePreview').classList.add('hidden');
  state.forwardSelectedConvIds = new Set();
  $('#forwardSearchInput').value = '';
  renderForwardConvList('');
  updateForwardSendBtn();
  showModal('#forwardModal');
}

function renderForwardConvList(query) {
  const el = $('#forwardConvList');
  el.innerHTML = '';
  const q = query.trim().toLowerCase();
  const list = forwardableConversations().filter((c) => !q || convTitle(c).toLowerCase().includes(q));
  if (!list.length) {
    el.innerHTML = '<div class="empty-hint">Чаты не найдены</div>';
    return;
  }
  list.forEach((conv) => el.appendChild(buildForwardConvRow(conv)));
}
$('#forwardSearchInput').addEventListener('input', () => renderForwardConvList($('#forwardSearchInput').value));

function buildForwardConvRow(conv) {
  const row = document.createElement('div');
  row.className = 'user-row forward-conv-row' + (state.forwardSelectedConvIds.has(conv.id) ? ' selected' : '');
  const title = convTitle(conv);
  const avatarSubject = conv.type === 'dm' ? conv.peer : conv;
  const avatarUrl = avatarSubject && avatarSubject.avatar;
  const av = document.createElement('div');
  av.className = 'avatar';
  if (avatarUrl) av.style.cssText = avatarStyle(avatarSubject); else av.textContent = initials(title);
  row.appendChild(av);
  const nameEl = document.createElement('div');
  nameEl.className = 'grow';
  nameEl.textContent = title;
  row.appendChild(nameEl);
  const check = document.createElement('div');
  check.className = 'forward-check';
  check.textContent = '✓';
  row.appendChild(check);
  row.addEventListener('click', () => {
    if (state.forwardSelectedConvIds.has(conv.id)) state.forwardSelectedConvIds.delete(conv.id);
    else state.forwardSelectedConvIds.add(conv.id);
    row.classList.toggle('selected');
    updateForwardSendBtn();
  });
  return row;
}

function updateForwardSendBtn() {
  const btn = $('#forwardSendBtn');
  const n = state.forwardSelectedConvIds.size;
  btn.disabled = n === 0;
  const verb = state.shareDraft ? 'Отправить' : 'Переслать';
  btn.textContent = n ? `${verb} (${n})` : verb;
}

$('#forwardSendBtn').addEventListener('click', () => {
  if (state.shareDraft) { sendSharedDraft(); return; }
  if (!state.forwardMessage || !state.forwardSelectedConvIds.size) return;
  const toConversationIds = [...state.forwardSelectedConvIds];
  if (state.ws && state.ws.readyState === 1) {
    state.ws.send(JSON.stringify({ type: 'forward', messageId: state.forwardMessage.id, toConversationIds }));
  }
  $('#forwardModal').classList.add('hidden');
  showToast(toConversationIds.length > 1 ? 'Сообщение переслано в несколько чатов' : 'Сообщение переслано');
  state.forwardMessage = null;
  state.forwardSelectedConvIds = new Set();
});



/* ---------------- «ПОДЕЛИТЬСЯ» ИЗ ДРУГИХ ПРИЛОЖЕНИЙ (Android) ---------------- */

// Нативный MainActivity вызывает window.handleSharedContentFromAndroid(json),
// когда пользователь в другом приложении выбрал «Поделиться → Asteria».
// json = { text, files: [{ url, name, mime, size }] }; файлы забираются по
// url (его перехватывает WebView и отдаёт содержимое из content://).
const SHARE_MIME_EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/heic': '.heic',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/3gpp': '.3gp',
  'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/ogg': '.ogg', 'audio/wav': '.wav',
  'application/pdf': '.pdf', 'text/plain': '.txt',
};

function shareMsgTypeForMime(mime) {
  if (/^image\//.test(mime)) return 'image';
  if (/^video\//.test(mime)) return 'video';
  if (/^audio\//.test(mime)) return 'music';
  return 'file';
}

function handleSharedContentFromAndroid(payload, attemptsLeft) {
  let draft = payload;
  if (typeof draft === 'string') { try { draft = JSON.parse(draft); } catch (e) { return; } }
  if (!draft || (!draft.text && !(draft.files && draft.files.length))) return;
  if (attemptsLeft === undefined) attemptsLeft = 240; // ~2 минуты: человек может ещё входить в аккаунт
  // Ждём, пока пользователь войдёт и подгрузятся чаты
  if (!state.user || !state.conversations.length) {
    if (attemptsLeft <= 0) {
      if (state.user) showToast('Нет чатов, в которые можно отправить');
      return;
    }
    setTimeout(() => handleSharedContentFromAndroid(draft, attemptsLeft - 1), 500);
    return;
  }
  switchSection('chats');
  openSharePicker(draft);
}
window.handleSharedContentFromAndroid = handleSharedContentFromAndroid;

function openSharePicker(draft) {
  state.shareDraft = draft;
  state.forwardMessage = null;
  state.forwardSelectedConvIds = new Set();
  $('#forwardSearchInput').value = '';
  $('#forwardModalTitleText').textContent = 'Отправить в…';
  const prev = $('#forwardSharePreview');
  const parts = [];
  const nFiles = (draft.files || []).length;
  if (nFiles) parts.push(nFiles === 1 ? `📎 ${draft.files[0].name}` : `📎 Файлов: ${nFiles}`);
  if (draft.text) parts.push(draft.text.length > 120 ? draft.text.slice(0, 120) + '…' : draft.text);
  prev.textContent = parts.join('\n');
  prev.style.whiteSpace = 'pre-wrap';
  prev.classList.remove('hidden');
  renderForwardConvList('');
  updateForwardSendBtn();
  showModal('#forwardModal');
}

async function sendSharedDraft() {
  const draft = state.shareDraft;
  const convIds = [...state.forwardSelectedConvIds];
  if (!draft || !convIds.length) return;
  if (!state.ws || state.ws.readyState !== 1) { showToast('Нет соединения с сервером'); return; }
  const btn = $('#forwardSendBtn');
  btn.disabled = true;
  btn.textContent = 'Отправка…';

  const sendTo = (convId, msgType, content, mediaUrl, meta) => {
    state.ws.send(JSON.stringify({
      type: 'message', conversationId: convId, msgType, content: content || '',
      mediaUrl: mediaUrl || null, meta: meta || null, replyToId: null,
    }));
  };

  // 1) Каждый файл загружаем на сервер один раз — дальше URL используется для всех чатов
  const uploaded = [];
  for (const f of (draft.files || [])) {
    try {
      const resp = await fetch(f.url);
      if (!resp.ok) throw new Error('read');
      const blob = await resp.blob();
      let name = f.name || 'file';
      if (!/\.[A-Za-z0-9]{1,6}$/.test(name)) name += SHARE_MIME_EXT[f.mime] || '';
      const file = new File([blob], name, { type: f.mime || blob.type });
      const kind = shareMsgTypeForMime(file.type);
      const url = await uploadFile(file, kind);
      uploaded.push({ url, kind, name: file.name, size: file.size, mime: file.type });
    } catch (e) {
      showToast(`Не удалось отправить «${f.name || 'файл'}»`);
    }
  }
  if (!uploaded.length && !draft.text) {
    btn.disabled = false; updateForwardSendBtn();
    return;
  }

  // 2) Рассылаем по выбранным чатам. Текст + ровно один файл — подпись к файлу.
  const text = (draft.text || '').trim();
  const captionOnFile = uploaded.length === 1 && text;
  convIds.forEach((convId) => {
    if (text && !captionOnFile) sendTo(convId, 'text', text, null, null);
    const visual = uploaded.filter((u) => u.kind === 'image' || u.kind === 'video');
    const others = uploaded.filter((u) => u.kind !== 'image' && u.kind !== 'video');
    if (visual.length === 1) {
      const u = visual[0];
      sendTo(convId, u.kind, captionOnFile ? text : '', u.url, { name: u.name, size: u.size, mime: u.mime });
    } else if (visual.length > 1) {
      // Несколько фото/видео — альбомом, по 10 штук (как в обычной отправке)
      for (let i = 0; i < visual.length; i += MAX_MEDIA_BATCH) {
        const chunk = visual.slice(i, i + MAX_MEDIA_BATCH);
        if (chunk.length === 1) sendTo(convId, chunk[0].kind, '', chunk[0].url, { name: chunk[0].name, size: chunk[0].size, mime: chunk[0].mime });
        else sendTo(convId, 'album', '', null, { items: chunk });
      }
    }
    others.forEach((u) => sendTo(convId, u.kind, captionOnFile ? text : '', u.url, { name: u.name, size: u.size, mime: u.mime }));
  });

  $('#forwardModal').classList.add('hidden');
  state.shareDraft = null;
  state.forwardSelectedConvIds = new Set();
  showToast(convIds.length > 1 ? 'Отправлено в несколько чатов' : 'Отправлено');
  if (convIds.length === 1) openConversation(convIds[0]);
}

/* ---------------- STICKERS ---------------- */

const stickerPanel = $('#stickerPanel');
STICKERS.forEach((s) => {
  const b = document.createElement('button');
  b.textContent = s;
  b.addEventListener('click', () => { sendWSMessage('sticker', s); $('#stickerModal').classList.add('hidden'); });
  stickerPanel.appendChild(b);
});
// Стикеры — тоже шторка-модалка поверх чата: сообщения и композер не двигаются.
$('#stickerBtn').addEventListener('click', () => openSheetModal('#stickerModal'));

/* ---------------- ФОРМАТИРОВАНИЕ ТЕКСТА ---------------- */
// Оборачивает выделенный в textarea фрагмент маркерами markdown-разметки
// (или вставляет маркеры с плейсхолдером, если ничего не выделено), после
// чего ставит курсор в удобное для продолжения ввода место.
function wrapSelectionWithMarkers(marker, placeholder) {
  const ta = $('#messageInput');
  const start = ta.selectionStart, end = ta.selectionEnd;
  const value = ta.value;
  const selected = value.slice(start, end) || placeholder;
  const before = value.slice(0, start);
  const after = value.slice(end);
  ta.value = before + marker + selected + marker + after;
  const cursorFrom = before.length + marker.length;
  ta.focus();
  ta.setSelectionRange(cursorFrom, cursorFrom + selected.length);
  ta.dispatchEvent(new Event('input'));
}
function insertLinkMarkup() {
  const ta = $('#messageInput');
  const start = ta.selectionStart, end = ta.selectionEnd;
  const value = ta.value;
  const selectedText = value.slice(start, end) || 'текст ссылки';
  const url = window.prompt('Ссылка (например, https://example.com):', 'https://');
  if (!url || !/^https?:\/\//i.test(url.trim())) { if (url !== null) alert('Ссылка должна начинаться с http:// или https://'); return; }
  const markup = `[${selectedText}](${url.trim()})`;
  ta.value = value.slice(0, start) + markup + value.slice(end);
  const cursorTo = start + markup.length;
  ta.focus();
  ta.setSelectionRange(cursorTo, cursorTo);
  ta.dispatchEvent(new Event('input'));
}
function applyFormat(type) {
  if (type === 'bold') wrapSelectionWithMarkers('**', 'жирный текст');
  else if (type === 'italic') wrapSelectionWithMarkers('*', 'курсив');
  else if (type === 'strike') wrapSelectionWithMarkers('~~', 'зачёркнутый');
  else if (type === 'code') wrapSelectionWithMarkers('`', 'код');
  else if (type === 'link') insertLinkMarkup();
}
$('#formatBtn').addEventListener('click', () => { $('#formatMenu').classList.toggle('hidden'); });
$all('#formatMenu button').forEach((btn) => {
  btn.addEventListener('click', () => { applyFormat(btn.dataset.format); $('#formatMenu').classList.add('hidden'); });
});
$('#messageInput').addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  if (e.key.toLowerCase() === 'b') { e.preventDefault(); applyFormat('bold'); }
  else if (e.key.toLowerCase() === 'i') { e.preventDefault(); applyFormat('italic'); }
  else if (e.key.toLowerCase() === 'k') { e.preventDefault(); applyFormat('link'); }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#formatBtn') && !e.target.closest('#formatMenu')) $('#formatMenu').classList.add('hidden');
});

/* ---------------- ВЫБОР ФОРМАТА ЗАПИСИ (MediaRecorder) ----------------
   Раньше и голосовые, и кружки писались через `new MediaRecorder(stream)`
   без указания mimeType, а получившийся Blob всегда жёстко подписывался
   как 'video/webm' / 'audio/webm' с именем файла 'circle.webm' / 'voice.webm'.
   На iOS Safari MediaRecorder webm вообще не поддерживает — там браузер
   сам пишет в mp4 (H.264/AAC), но мы всё равно называли файл .webm.
   В результате <video>/<audio> при воспроизведении получал файл с
   несоответствующим контейнеру расширением/MIME и не мог его декодировать —
   кружок оставался пустым (виден был только фон пузыря). Теперь явно
   спрашиваем у браузера, какой формат он реально поддерживает, и сохраняем
   и Blob, и имя файла в этом формате. */
function pickRecorderMime(candidates) {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  for (const type of candidates) {
    try { if (MediaRecorder.isTypeSupported(type)) return type; } catch (e) {}
  }
  return '';
}
function extForMime(mime) {
  if (!mime) return 'webm';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}

/* ---------------- ЗАПИСЬ ГОЛОСОВЫХ И КРУЖКОВ ----------------
   Запись больше не требует держать палец: достаточно удержать кнопку ~0,35 с,
   чтобы она началась, дальше запись идёт сама. Остановить — кнопкой «стоп»
   (■): тогда показывается превью записи, и только повторное нажатие
   «Отправить» (➤) отправляет её в чат; корзина/«Отменить» — удалить.

   Раньше на iPhone браузер при первом обращении к микрофону/камере показывал
   системный запрос, палец за это время успевал оторваться от кнопки, а запись
   стартовала уже ПОСЛЕ этого — и остановить её было нечем. Теперь:
   - у записи есть состояние (idle → starting → recording → stopping → preview
     → sending) и «жетон» recToken: любой ответ на запрос доступа, пришедший
     после отмены, сразу гасит свои дорожки и ничего не запускает;
   - отпускание/отмена касания после старта вообще ни на что не влияет;
   - пока запрос доступа не решён, повторное нажатие игнорируется — повторных
     запросов не будет. */
let recState = 'idle'; // idle | starting | recording | stopping | preview | sending
let recToken = 0;

function fmtVoiceTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function showVoiceBarMode(mode) { // 'recording' | 'preview' | null (скрыть)
  const bar = $('#voiceRecordingBar');
  if (!mode) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  bar.classList.toggle('previewing', mode === 'preview');
  $('#voiceActionBtn').innerHTML = mode === 'preview' ? '➤' : '<span class="vr-stop-sq"></span>';
  $('#voiceActionBtn').title = mode === 'preview' ? 'Отправить' : 'Остановить запись';
}

function cleanupVoice() {
  clearInterval(state.voiceTimerInt);
  state.voiceTimerInt = null;
  if (state.voiceStream) { try { state.voiceStream.getTracks().forEach((t) => t.stop()); } catch (e) {} }
  state.voiceStream = null;
  if (state.voiceTranscriber) { try { state.voiceTranscriber.stop(); } catch (e) {} }
  state.voiceTranscriber = null;
  state.voiceRecorder = null;
  if (state.voicePreviewAudio) { try { state.voicePreviewAudio.pause(); } catch (e) {} }
  state.voicePreviewAudio = null;
  if (state.voicePreview && state.voicePreview.url) { try { URL.revokeObjectURL(state.voicePreview.url); } catch (e) {} }
  state.voicePreview = null;
  showVoiceBarMode(null);
}

async function startVoiceRecording(token) {
  let stream;
  try {
    stream = await getMedia({ audio: true });
  } catch (e) {
    if (token === recToken) { recState = 'idle'; }
    return;
  }
  if (token !== recToken || recState !== 'starting') { stream.getTracks().forEach((t) => t.stop()); return; }
  try {
    state.voiceStream = stream;
    state.voiceChunks = [];
    state.voiceMime = pickRecorderMime(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac']);
    const rec = state.voiceMime ? new MediaRecorder(stream, { mimeType: state.voiceMime }) : new MediaRecorder(stream);
    state.voiceRecorder = rec;
    rec.ondataavailable = (e) => { if (e.data.size) state.voiceChunks.push(e.data); };
    rec.onstop = () => onVoiceRecorderStopped(token);
    rec.start();
    state.voiceTranscriber = startLiveTranscription();
    state.voiceStartedAt = Date.now();
    recState = 'recording';
    $('#voiceTimer').textContent = '0:00';
    showVoiceBarMode('recording');
    state.voiceTimerInt = setInterval(() => {
      $('#voiceTimer').textContent = fmtVoiceTime((Date.now() - state.voiceStartedAt) / 1000);
    }, 250);
  } catch (e) {
    cleanupVoice();
    recState = 'idle';
    alert('Не удалось начать запись: ' + e.message);
  }
}

// «Стоп»: останавливаем запись и переходим к превью (ничего ещё не отправлено).
function stopVoiceToPreview() {
  if (recState !== 'recording' || !state.voiceRecorder) return;
  recState = 'stopping';
  clearInterval(state.voiceTimerInt);
  try {
    if (state.voiceRecorder.state !== 'inactive') state.voiceRecorder.stop();
    else onVoiceRecorderStopped(recToken);
  } catch (e) { onVoiceRecorderStopped(recToken); }
}

async function onVoiceRecorderStopped(token) {
  if (token !== recToken) return; // запись уже отменена
  const mime = state.voiceMime || 'audio/webm';
  const chunks = state.voiceChunks || [];
  const durationSec = (Date.now() - state.voiceStartedAt) / 1000;
  const transcriber = state.voiceTranscriber;
  state.voiceTranscriber = null;
  if (state.voiceStream) { try { state.voiceStream.getTracks().forEach((t) => t.stop()); } catch (e) {} }
  state.voiceStream = null;
  const transcript = transcriber ? await transcriber.stop() : '';
  if (token !== recToken) return;
  if (!chunks.length || durationSec < 0.4) { cleanupVoice(); recState = 'idle'; showToast('Слишком короткая запись'); return; }
  const blob = new Blob(chunks, { type: mime });
  const url = URL.createObjectURL(blob);
  state.voicePreview = { blob, url, mime, transcript, durationSec };
  const audio = new Audio(url);
  state.voicePreviewAudio = audio;
  const fill = $('#voicePreviewFill');
  const timeEl = $('#voicePreviewTime');
  const playBtn = $('#voicePlayBtn');
  fill.style.width = '0%'; playBtn.textContent = '▶'; timeEl.textContent = fmtVoiceTime(durationSec);
  audio.addEventListener('timeupdate', () => {
    const d = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : durationSec;
    fill.style.width = Math.min(100, (audio.currentTime / d) * 100) + '%';
    timeEl.textContent = fmtVoiceTime(audio.currentTime);
  });
  audio.addEventListener('ended', () => { playBtn.textContent = '▶'; fill.style.width = '0%'; timeEl.textContent = fmtVoiceTime(durationSec); });
  audio.addEventListener('pause', () => { playBtn.textContent = '▶'; });
  audio.addEventListener('play', () => { playBtn.textContent = '❚❚'; });
  recState = 'preview';
  showVoiceBarMode('preview');
}

function cancelVoiceRecording() {
  recToken++; // отменяем и ещё не начавшуюся запись
  const rec = state.voiceRecorder;
  if (rec && rec.state !== 'inactive') { rec.onstop = null; try { rec.stop(); } catch (e) {} }
  cleanupVoice();
  recState = 'idle';
}

function sendVoicePreview() {
  if (recState !== 'preview' || !state.voicePreview) return;
  const { blob, mime, transcript } = state.voicePreview;
  recState = 'sending';
  const file = new File([blob], `voice.${extForMime(mime)}`, { type: mime });
  cleanupVoice();
  recState = 'idle';
  sendFileWithPending(file, 'voice', 'voice', '', transcript ? { transcript } : {});
}

$('#voiceCancelBtn').addEventListener('click', cancelVoiceRecording);
$('#voiceActionBtn').addEventListener('click', () => {
  if (recState === 'recording') stopVoiceToPreview();
  else if (recState === 'preview') sendVoicePreview();
});
$('#voicePlayBtn').addEventListener('click', () => {
  const a = state.voicePreviewAudio;
  if (!a) return;
  if (a.paused) a.play().catch(() => {}); else a.pause();
});

/* ---------------- VIDEO CIRCLE (кружки) ---------------- */

function setCircleShutterIcon(mode) { // 'record' | 'send'
  const core = document.querySelector('#circleShutterBtn .circle-record-shutter-core');
  if (core) core.innerHTML = mode === 'send' ? '➤' : '<span class="vr-stop-sq"></span>';
  $('#circleShutterBtn').title = mode === 'send' ? 'Отправить' : 'Остановить запись';
}

function closeCircleModal() {
  clearTimeout(state.circleAutoStopTimer);
  const modal = $('#circleRecordModal');
  modal.classList.add('hidden');
  modal.classList.remove('recording', 'previewing');
  stopCircleTimerUi();
  if (state.circleStream) { try { state.circleStream.getTracks().forEach((t) => t.stop()); } catch (e) {} }
  state.circleStream = null;
  state.circleRecorder = null;
  if (state.circleTranscriber) { try { state.circleTranscriber.stop(); } catch (e) {} }
  state.circleTranscriber = null;
  const v = $('#circlePreview');
  try { v.pause(); } catch (e) {}
  v.srcObject = null; v.removeAttribute('src'); v.loop = false; v.muted = true; try { v.load(); } catch (e) {}
  if (state.circlePreview && state.circlePreview.url) { try { URL.revokeObjectURL(state.circlePreview.url); } catch (e) {} }
  state.circlePreview = null;
  setCircleShutterIcon('record');
}

function stopCircleToPreview() {
  if (recState !== 'recording' || !state.circleRecorder) return;
  recState = 'stopping';
  clearTimeout(state.circleAutoStopTimer);
  const rec = state.circleRecorder;
  try {
    if (rec.state !== 'inactive') rec.stop();
    else onCircleRecorderStopped(recToken);
  } catch (e) { onCircleRecorderStopped(recToken); }
}

async function onCircleRecorderStopped(token) {
  if (token !== recToken) return; // отменено
  clearTimeout(state.circleAutoStopTimer);
  stopCircleTimerUi();
  const elapsed = Date.now() - circleRecStartTs;
  const mime = state.circleMime || 'video/webm';
  const chunks = state.circleChunks || [];
  const transcriber = state.circleTranscriber;
  state.circleTranscriber = null;
  const transcript = transcriber ? await transcriber.stop() : '';
  if (token !== recToken) return;
  if (!chunks.length || elapsed < 500) { closeCircleModal(); recState = 'idle'; showToast('Слишком короткая запись'); return; }
  // камера больше не нужна — выключаем и показываем записанный кружок
  if (state.circleStream) { try { state.circleStream.getTracks().forEach((t) => t.stop()); } catch (e) {} }
  state.circleStream = null;
  const blob = new Blob(chunks, { type: mime });
  const url = URL.createObjectURL(blob);
  state.circlePreview = { blob, url, mime, transcript };
  const v = $('#circlePreview');
  v.srcObject = null; v.src = url; v.muted = false; v.loop = true;
  v.play().catch(() => {});
  const el = $('#circleRecordElapsed'); if (el) el.textContent = fmtCircleTimer(Math.min(elapsed, CIRCLE_MAX_MS));
  const modal = $('#circleRecordModal');
  modal.classList.remove('recording'); modal.classList.add('previewing');
  setCircleShutterIcon('send');
  recState = 'preview';
}

function cancelCircleRecording() {
  recToken++;
  const rec = state.circleRecorder;
  if (rec && rec.state !== 'inactive') { rec.onstop = null; try { rec.stop(); } catch (e) {} }
  closeCircleModal();
  recState = 'idle';
}

function sendCirclePreview() {
  if (recState !== 'preview' || !state.circlePreview) return;
  const { blob, mime, transcript } = state.circlePreview;
  recState = 'sending';
  const file = new File([blob], `circle.${extForMime(mime)}`, { type: mime });
  closeCircleModal();
  recState = 'idle';
  sendFileWithPending(file, 'circle', 'video_circle', '', transcript ? { transcript } : {});
}

/* ---------------- ОБЪЕДИНЁННАЯ КНОПКА: голосовое / видео-кружок ----------------
   Раньше это были 2 отдельные кнопки рядом с кнопкой отправки — на маленьких
   мобильных экранах места на всё не хватало, и кнопка отправки сжималась или
   вообще пропадала за край экрана. Теперь это одна кнопка: короткий тап
   переключает режим (голосовое ⇄ кружок), нажатие и удержание — начинает
   запись в текущем режиме, отпускание — останавливает и отправляет (свайп
   вверх во время удержания — отмена, как в Telegram). Кнопка вообще не
   показывается, пока в поле ввода есть текст — тогда видна только кнопка
   отправки. */
let recordMode = 'voice'; // 'voice' | 'circle'
let recordHoldTimer = null;
let recordActive = false; // true, когда порог удержания пройден и запись реально идёт
let recordStartX = 0, recordStartY = 0;
const RECORD_HOLD_MS = 350;
const RECORD_CANCEL_DRAG_PX = 70;
const CIRCLE_MAX_MS = 15000; // максимальная длительность видео-кружка

// Состояние полноэкранного оверлея записи кружка: "залочена" ли запись —
// тогда отпускание основной кнопки её НЕ останавливает, запись продолжается
// до тапа по шаттеру/"Отменить" прямо в оверлее (как долгое удержание с
// последующим свайпом-локом в Telegram/WhatsApp). Плюс вспышка, текущая
// камера и таймер для счётчика времени + кольца прогресса вокруг превью.
let circleLocked = false;
let circleFlashOn = false;
let circleRecFacing = 'user';
let circleRecStartTs = 0;
let circleTimerInterval = null;

function updateRecordBtnUi() {
  const btn = $('#recordBtn');
  if (recordMode === 'voice') {
    btn.textContent = '🎙';
    btn.title = 'Голосовое сообщение — нажмите и удерживайте (тап — переключить на видео-кружок)';
  } else {
    btn.textContent = '⭕';
    btn.title = 'Видео-кружок — нажмите и удерживайте (тап — переключить на голосовое)';
  }
}
updateRecordBtnUi();

function fmtCircleTimer(ms) {
  const total = Math.max(0, ms);
  const mm = Math.floor(total / 60000);
  const ss = Math.floor((total % 60000) / 1000);
  const cc = Math.floor((total % 1000) / 10);
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')},${String(cc).padStart(2, '0')}`;
}

function circleProgressCirc() {
  return 2 * Math.PI * 48; // должен совпадать с r=48 у .circle-record-progress-bar в SVG
}

function startCircleTimerUi() {
  const bar = document.querySelector('#circleRecordModal .circle-record-progress-bar');
  const circ = circleProgressCirc();
  if (bar) { bar.style.strokeDasharray = String(circ); bar.style.strokeDashoffset = '0'; }
  circleRecStartTs = Date.now();
  clearInterval(circleTimerInterval);
  circleTimerInterval = setInterval(() => {
    const elapsed = Date.now() - circleRecStartTs;
    const el = $('#circleRecordElapsed');
    if (el) el.textContent = fmtCircleTimer(elapsed);
    if (bar) bar.style.strokeDashoffset = String(circ * (1 - Math.min(1, elapsed / CIRCLE_MAX_MS)));
  }, 50);
}
function stopCircleTimerUi() {
  clearInterval(circleTimerInterval);
  circleTimerInterval = null;
  const el = $('#circleRecordElapsed');
  if (el) el.textContent = '00:00,00';
  const bar = document.querySelector('#circleRecordModal .circle-record-progress-bar');
  if (bar) bar.style.strokeDashoffset = String(circleProgressCirc());
}


// Общая, устойчивая к особенностям Android смена фронтальной/тыловой
// камеры "на лету" — используется и на 1:1 звонке (flipCamera), и в
// кружке-видео (flipCircleCamera), и в групповом звонке (flipGroupCamera).
//
// БАГ, который во всех трёх местах выглядел одинаково ("переворачивает
// камеру, а сразу после этого — на следующем перевороте — пишет, что
// камеры больше нет"): раньше сначала запрашивался НОВЫЙ поток другой
// камеры через getUserMedia, и только ПОТОМ останавливался старый трек
// (oldTrack.stop()). На десктопе так можно — там браузер свободно держит
// открытыми несколько веб-камер. На Android так нельзя: WebView отдаёт
// доступ к камере через Camera2 HAL, а он не даёт одновременно держать
// открытыми фронтальную и тыловую камеру на большинстве телефонов.
// Первый переворот при этом обычно проходит (вторая камера ещё ни разу не
// открывалась, свободна) — но старая камера в момент второго
// getUserMedia() ещё считается занятой (JS её уже "отпустил" вызовом
// stop(), а вот ОС освобождает физическое устройство асинхронно, с
// задержкой). Второй переворот (запрос уже ПЕРВОЙ, "исходной" камеры)
// натыкается на неё же в состоянии "ещё не освобождена" — отсюда
// NotReadableError/"камера не найдена" сразу после одного успешного
// переключения.
//
// Чиним, останавливая старую камеру ПЕРВОЙ и давая ей время реально
// освободиться, прежде чем просить новую — а если новую всё равно не
// открыть с первой попытки, ждём ещё и пробуем один раз повторно, прежде
// чем сдаться (а не остаёмся вовсе без картинки).
async function swapCameraTrack(oldTrack, prevFacing) {
  const nextFacing = prevFacing === 'environment' ? 'user' : 'environment';
  oldTrack.stop();
  await new Promise((r) => setTimeout(r, 250));
  async function acquire(facing) {
    const s = await getMedia({ video: { facingMode: facing }, audio: false }, { silent: true });
    const t = s.getVideoTracks()[0];
    if (!t) throw new Error('Камера не вернула видеодорожку');
    return t;
  }
  try {
    return { track: await acquire(nextFacing), facing: nextFacing };
  } catch (e) {
    // Часть Android-камер отпускает предыдущее устройство ещё медленнее —
    // даём больше времени и пробуем один раз повторно, прежде чем сдаться.
    await new Promise((r) => setTimeout(r, 400));
    try {
      return { track: await acquire(nextFacing), facing: nextFacing };
    } catch (e2) {
      // Не удалось открыть новую камеру — пробуем вернуть хотя бы
      // прежнюю, чтобы человек не остался вовсе без изображения на
      // звонке. Если и это не выйдет — исключение уйдёт вызывающей
      // функции, она уже покажет ошибку пользователю.
      return { track: await acquire(prevFacing), facing: prevFacing };
    }
  }
}

// Смена камеры прямо во время записи: заменяем видеодорожку в уже
// работающем MediaStream (аудиодорожка и сам MediaRecorder не трогаются).
async function flipCircleCamera() {
  if (!state.circleStream) return;
  const oldTrack = state.circleStream.getVideoTracks()[0];
  if (!oldTrack) return;
  try {
    state.circleStream.removeTrack(oldTrack);
    const { track: newTrack, facing } = await swapCameraTrack(oldTrack, circleRecFacing);
    state.circleStream.addTrack(newTrack);
    $('#circlePreview').srcObject = state.circleStream;
    circleRecFacing = facing;
  } catch (e) {
    // тихо игнорируем — не у всех устройств есть вторая камера
  }
}

// Вспышка/фонарик — best-effort через track.applyConstraints({torch}),
// поддерживается не везде, поэтому ошибки просто проглатываем.
async function toggleCircleFlash() {
  if (!state.circleStream) return;
  const track = state.circleStream.getVideoTracks()[0];
  if (!track) return;
  circleFlashOn = !circleFlashOn;
  $('#circleFlashBtn').classList.toggle('active', circleFlashOn);
  try { await track.applyConstraints({ advanced: [{ torch: circleFlashOn }] }); } catch (e) {}
}

async function beginCircleRecording(token) {
  circleFlashOn = false;
  circleRecFacing = 'user';
  $('#circleFlashBtn').classList.remove('active');
  setCircleShutterIcon('record');
  showModal('#circleRecordModal');
  let stream;
  try {
    stream = await getMedia({ video: { facingMode: circleRecFacing }, audio: true });
  } catch (e) {
    if (token === recToken) { recState = 'idle'; closeCircleModal(); }
    return;
  }
  if (token !== recToken || recState !== 'starting') { stream.getTracks().forEach((t) => t.stop()); return; }
  try {
    state.circleStream = stream;
    const v = $('#circlePreview');
    v.muted = true; v.loop = false; v.srcObject = stream;
    state.circleChunks = [];
    state.circleMime = pickRecorderMime(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4;codecs=h264,aac', 'video/mp4']);
    const rec = state.circleMime ? new MediaRecorder(stream, { mimeType: state.circleMime }) : new MediaRecorder(stream);
    state.circleRecorder = rec;
    rec.ondataavailable = (e) => { if (e.data.size) state.circleChunks.push(e.data); };
    rec.onstop = () => onCircleRecorderStopped(token);
    rec.start();
    state.circleTranscriber = startLiveTranscription();
    startCircleTimerUi();
    $('#circleRecordModal').classList.add('recording');
    recState = 'recording';
    // по лимиту длительности запись сама останавливается и переходит к превью
    state.circleAutoStopTimer = setTimeout(() => { if (recState === 'recording') stopCircleToPreview(); }, CIRCLE_MAX_MS);
  } catch (e) {
    closeCircleModal();
    recState = 'idle';
    alert('Не удалось начать запись: ' + e.message);
  }
}

// Удержание кнопки сработало: запускаем запись. Дальше палец держать не нужно.
function beginHoldRecording() {
  if (recState !== 'idle') return;
  recState = 'starting';
  const token = ++recToken;
  if (recordMode === 'voice') startVoiceRecording(token);
  else beginCircleRecording(token);
}

const recordBtnEl = $('#recordBtn');
let recordPressFired = false;
recordBtnEl.addEventListener('pointerdown', (e) => {
  if (e.button !== undefined && e.button !== 0) return;
  if (recState !== 'idle') return;
  recordPressFired = false;
  clearTimeout(recordHoldTimer);
  recordHoldTimer = setTimeout(() => { recordPressFired = true; beginHoldRecording(); }, RECORD_HOLD_MS);
});
recordBtnEl.addEventListener('pointerup', () => {
  clearTimeout(recordHoldTimer);
  // Короткий тап — переключаем режим. Если удержание уже запустило запись,
  // отпускание кнопки ничего не меняет (запись идёт без удержания).
  if (recordPressFired || recState !== 'idle') { recordPressFired = false; return; }
  recordMode = recordMode === 'voice' ? 'circle' : 'voice';
  updateRecordBtnUi();
});
// Касание сорвано (например, системным запросом доступа к микрофону) — до
// старта это просто отмена нажатия, после старта — ничего.
recordBtnEl.addEventListener('pointercancel', () => { clearTimeout(recordHoldTimer); });
recordBtnEl.addEventListener('contextmenu', (e) => e.preventDefault());

// Кнопки полноэкранного оверлея записи кружка.
$('#circleRecordCancelBtn').addEventListener('click', cancelCircleRecording);
$('#circleShutterBtn').addEventListener('click', () => {
  if (recState === 'recording') stopCircleToPreview();
  else if (recState === 'preview') sendCirclePreview();
});
$('#circleFlipBtn').addEventListener('click', flipCircleCamera);
$('#circleFlashBtn').addEventListener('click', toggleCircleFlash);

/* ---------------- MODALS generic ---------------- */

$all('.modal-close').forEach((btn) => btn.addEventListener('click', () => {
  const id = btn.dataset.close;
  $('#' + id).classList.add('hidden');
  if (id === 'forwardModal') state.shareDraft = null;
  if (id === 'circleRecordModal') cancelCircleRecording();
}));

// Закрытие шторки свайпом вниз: тянем за верхнюю часть (ручка + заголовок).
// Работает, пока содержимое шторки не прокручено, чтобы не мешать прокрутке.
(function initSheetDragToClose() {
  let st = null;
  const SHEET = '.modal:not(.story-modal):not(.miniapp-modal) .modal-card';
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || !e.target.closest) return;
    const card = e.target.closest(SHEET);
    if (!card || card.scrollTop > 0) return;
    const y = e.touches[0].clientY;
    if (y - card.getBoundingClientRect().top > 48) return;
    st = { card, y0: y, dy: 0 };
    card.style.transition = 'none';
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!st) return;
    st.dy = Math.max(0, e.touches[0].clientY - st.y0);
    st.card.style.transform = `translateY(${st.dy}px)`;
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
  function end() {
    if (!st) return;
    const { card, dy } = st; st = null;
    card.style.transition = 'transform .22s var(--ease-liquid)';
    if (dy > 90) {
      card.style.transform = 'translateY(100%)';
      setTimeout(() => {
        card.style.transition = ''; card.style.transform = '';
        const closeBtn = card.querySelector('.modal-close');
        if (closeBtn) closeBtn.click(); else card.closest('.modal').classList.add('hidden');
      }, 200);
    } else {
      card.style.transform = '';
      setTimeout(() => { card.style.transition = ''; }, 240);
    }
  }
  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', end, { passive: true });
})();

/* ---------------- SETTINGS (теперь отдельный раздел, не модалка) ---------------- */

function toggleAvatarRing(el, u) {
  if (!el) return;
  // Кольцо вокруг аватара отключено.
  el.classList.remove('avatar-premium-ring');
}
function renderMyAvatar() {
  const av = $('#myAvatar');
  av.textContent = state.user.avatar ? '' : initials(state.user.displayName);
  av.style.cssText = avatarStyle(state.user);
  toggleAvatarRing(av, state.user);
  const av2 = $('#settingsAvatarPreview');
  av2.textContent = state.user.avatar ? '' : initials(state.user.displayName);
  av2.style.cssText = avatarStyle(state.user);
  toggleAvatarRing(av2, state.user);
  av2.classList.toggle('avatar-clickable', !!state.user.avatar);
  av2.title = state.user.avatar ? 'Открыть фото профиля' : '';
  // renderMyAvatar() перерисовывается многократно (при каждом изменении
  // профиля) — используем onclick, а не addEventListener, чтобы не
  // накапливать дублирующиеся обработчики на одном и том же узле.
  av2.onclick = state.user.avatar ? () => openAvatarLightbox(state.user.avatar) : null;
  const av3 = $('#settingsHeaderAvatar');
  if (av3) {
    av3.textContent = state.user.avatar ? '' : initials(state.user.displayName);
    av3.style.cssText = avatarStyle(state.user);
    toggleAvatarRing(av3, state.user);
  }
  const hdrName = $('#settingsHeaderName');
  if (hdrName) hdrName.textContent = state.user.displayName || '';
  const hdrSub = $('#settingsHeaderSub');
  if (hdrSub) {
    const parts = [];
    if (state.user.username) parts.push('@' + state.user.username);
    hdrSub.textContent = parts.join(' • ');
  }
}

/* ---------------- НАСТРОЙКИ: список пунктов и дочерние страницы ---------------- */

const SETTINGS_SUBPAGES = {
  profile:       { titleKey: 'settings_my_profile',    title: 'Мой профиль',          el: 'subPageProfile' },
  wallet:        { titleKey: 'settings_wallet',        title: 'Кошелёк',               el: 'subPageWallet' },
  favorites:     { titleKey: 'settings_favorites',     title: 'Избранное',             el: 'subPageFavorites' },
  devices:       { titleKey: 'settings_devices',       title: 'Устройства',            el: 'subPageDevices' },
  folders:       { titleKey: 'settings_folders',       title: 'Папки с чатами',        el: 'subPageFolders' },
  notifications: { titleKey: 'settings_notifications', title: 'Уведомления и звуки',   el: 'subPageNotifications' },
  privacy:       { titleKey: 'settings_privacy',       title: 'Конфиденциальность',    el: 'subPagePrivacy' },
  storage:       { titleKey: 'settings_storage',       title: 'Данные и память',       el: 'subPageStorage' },
  appearance:    { titleKey: 'settings_appearance',    title: 'Оформление',            el: 'subPageAppearance' },
  powersaving:   { titleKey: 'settings_powersaving',   title: 'Энергосбережение',      el: 'subPagePowerSaving' },
  applock:       { title: 'Код-пароль',            el: 'subPageAppLock' },
  choice:        { title: 'Выбор',                  el: 'subPageChoice' },
  language:      { titleKey: 'settings_language',      title: 'Язык',                  el: 'subPageLanguage' },
};


function populateProfileViewInfo() {
  const u = state.user;
  $('#profileHeroName').textContent = u.displayName || '';
  $('#profileHeroUsername').textContent = u.username ? '@' + u.username : '';
  $('#profileInfoUsername').textContent = u.username ? '@' + u.username : '—';
  $('#profileInfoStatus').textContent = u.status || '—';
  $('#profileInfoJoined').textContent = u.createdAt ? fmtDate(u.createdAt) : '—';
}
function setProfileEditMode(on) {
  $('#profileViewMode').classList.toggle('hidden', on);
  $('#profileEditMode').classList.toggle('hidden', !on);
  // Управляет видимостью кнопки-камеры на аватаре и ссылки "Удалить фото"
  // (см. .profile-editing в style.css) — обе живут в .profile-hero, то
  // есть вне #profileEditMode, потому что аватар должен визуально
  // оставаться на месте и в режиме просмотра, и в режиме редактирования.
  $('#subPageProfile').classList.toggle('profile-editing', on);
  $('#profileEditToggleBtn').textContent = on ? 'Готово' : 'Изм.';
  if (on) {
    $('#settingsDisplayName').value = state.user.displayName || '';
    $('#settingsUsername').value = state.user.username || '';
    $('#settingsStatus').value = state.user.status || '';
    $('#settingsError').textContent = '';
  }
}
$('#profileEditToggleBtn').addEventListener('click', async () => {
  const isEditing = !$('#profileEditMode').classList.contains('hidden');
  if (isEditing) {
    const ok = await saveProfileSettings();
    if (!ok) return; // остаёмся в режиме редактирования, показываем ошибку
    setProfileEditMode(false);
  } else {
    setProfileEditMode(true);
  }
});
$('#profileQrBtn').addEventListener('click', () => {
  openShareModal(state.user.displayName, buildProfileLink(state.user.username));
});

function openSettingsSubpage(key) {
  if (key === 'calls') { switchSection('calls'); return; }
  const cfg = SETTINGS_SUBPAGES[key];
  if (!cfg) return;
  $('#settingsMainView').classList.add('hidden');
  $('#settingsSubView').classList.remove('hidden');
  // #sectionSettings — ЕДИНЫЙ скроллящийся контейнер сразу для главного
  // списка настроек И для всех подстраниц (они просто показываются/
  // прячутся через .hidden внутри него, а не рендерятся в отдельных
  // независимо скроллящихся вью). Поэтому scrollTop, оставшийся, например,
  // от пролистанного вниз списка настроек или предыдущей длинной
  // подстраницы, никуда не девался при переходе на другую подстраницу —
  // "Конфиденциальность" могла открыться уже прокрученной вниз, хотя
  // пользователь её не листал. Сбрасываем позицию на новой подстранице.
  $('#sectionSettings').scrollTop = 0;
  // На мобильном нижняя плашка чаты/звонки/настройки должна прятаться,
  // когда открыт конкретный пункт настроек (профиль, оформление и т.д.) —
  // так же, как она прячется при открытом чате (см. .chat-open ниже).
  $('#appScreen').classList.add('settings-sub-open');
  $('#settingsSubTitle').textContent = (cfg.titleKey && typeof t === 'function') ? t(cfg.titleKey) : cfg.title;
  $all('.settings-sub-page').forEach((p) => p.classList.add('hidden'));
  $('#' + cfg.el).classList.remove('hidden');
  $('#profileEditToggleBtn').classList.toggle('hidden', key !== 'profile');
  if (key === 'profile') {
    populateProfileViewInfo();
    setProfileEditMode(false);
  }
  if (key === 'applock') refreshAppLockPage();
  if (key === 'privacy') {
    refreshAppLockStatus();
    $('#discoverableCheckbox').checked = state.user.discoverable !== false;
    refreshHideOnlineCheckbox();
    refreshHideReadStatusCheckbox();
    refreshPrivacyExtras();
    $('#passwordError').textContent = '';
    $('#currentPasswordInput').value = '';
    $('#newPasswordInput').value = '';
    $all('#passwordStrength span').forEach((b) => b.className = '');
    $all('.password-toggle-eye').forEach((btn) => { const inp = $('#' + btn.dataset.toggle); if (inp) inp.type = 'password'; btn.textContent = '👁'; });
  }
  if (key === 'folders') renderFoldersInSettings();
  if (key === 'devices') renderDevicesInSettings();
  if (key === 'appearance') { highlightActiveThemeSwatch(); renderWallpaperPresets(); }
  if (key === 'notifications') { $('#notificationsStatus').textContent = ''; refreshRingtoneSettingsUI(); }
}
function closeSettingsSubpage() {
  // Запоминаем ДО сброса класса: была ли подстраница реально открыта.
  // closeSettingsSubpage() вызывается в двух разных ситуациях —
  // 1) пользователь нажал "Назад" из открытой подстраницы настроек
  //    (панель нижней навигации была скрыта классом .settings-sub-open);
  // 2) "на всякий случай" из openSettingsPage() при обычном переключении
  //    на вкладку "Настройки" через switchSection() — панель в этот момент
  //    уже видима, и switchSection() уже сам плавно (с анимацией) поставил
  //    плашку на "Настройки" парой строк выше.
  // Раньше плашка пересчитывалась без анимации в обоих случаях — из-за
  // этого при обычном переключении на "Настройки" (случай 2) этот вызов
  // синхронно "глушил" анимацию, которую только что запустил switchSection
  // (баг: плашка прыгала на настройки мгновенно, без анимации). Пересчёт
  // без анимации на самом деле нужен только в случае 1 (панель до этого
  // была скрыта, поэтому её реальные размеры могли устареть — см. подробный
  // комментарий в moveBottomNavIndicator()).
  const wasSubpageOpen = $('#appScreen').classList.contains('settings-sub-open');
  $('#settingsSubView').classList.add('hidden');
  $('#settingsMainView').classList.remove('hidden');
  $('#appScreen').classList.remove('settings-sub-open');
  // Та же причина, что и в openSettingsSubpage() — общий скролл-контейнер
  // #sectionSettings, сброс позиции при возврате к списку.
  if (wasSubpageOpen) $('#sectionSettings').scrollTop = 0;
  if (wasSubpageOpen) moveBottomNavIndicator(state.activeSection || 'settings', false);
}
$all('[data-settings-page]').forEach((btn) => btn.addEventListener('click', () => openSettingsSubpage(btn.dataset.settingsPage)));
$('#settingsSubBackBtn').addEventListener('click', () => {
  // Из подстраницы выбора возвращаемся на страницу, откуда её открыли.
  if (!$('#subPageChoice').classList.contains('hidden')) { openSettingsSubpage(choiceReturnKey); return; }
  closeSettingsSubpage();
});
const digitalIdRow = document.getElementById('digitalIdRow');
if (digitalIdRow) digitalIdRow.addEventListener('click', () => openMiniApp('/miniapps/riveo.html', 'Цифровой ID'));
$('#changePhotoRow').addEventListener('click', () => $('#avatarInput').click());
$('#enableNotificationsBtn').addEventListener('click', () => {
  if (!('Notification' in window)) { $('#notificationsStatus').textContent = 'Уведомления не поддерживаются этим браузером'; return; }
  Notification.requestPermission().then((perm) => {
    $('#notificationsStatus').style.color = perm === 'granted' ? 'var(--accent-2)' : 'var(--danger)';
    $('#notificationsStatus').textContent = perm === 'granted' ? 'Уведомления включены ✓' : 'Уведомления отклонены';
    if (perm === 'granted') subscribeToPush();
  });
});
$('#powerSavingCheckbox').addEventListener('change', (e) => {
  $('#powerSavingValue').textContent = e.target.checked ? 'Вкл.' : 'Выкл.';
  try { localStorage.setItem(POWER_SAVING_STORAGE_KEY, e.target.checked ? '1' : '0'); } catch (err) {}
});
// Восстанавливаем сохранённое значение при загрузке страницы — раньше
// чекбокс никогда никуда не сохранялся и не читался, поэтому после
// перезагрузки/закрытия вкладки всегда возвращался к состоянию по
// умолчанию (выключено), даже если пользователь его включал.
try {
  const savedPowerSaving = localStorage.getItem(POWER_SAVING_STORAGE_KEY) === '1';
  $('#powerSavingCheckbox').checked = savedPowerSaving;
  $('#powerSavingValue').textContent = savedPowerSaving ? 'Вкл.' : 'Выкл.';
} catch (e) {}

function openSettingsPage() {
  closeSettingsSubpage();
  renderMyAvatar();
  $('#discoverableCheckbox').checked = state.user.discoverable !== false;
  refreshHideOnlineCheckbox();
  refreshHideReadStatusCheckbox();
}
$('#changeAvatarBtn').addEventListener('click', () => $('#avatarInput').click());
$('#avatarInput').addEventListener('change', async () => {
  const file = $('#avatarInput').files[0];
  if (!file) return;
  $('#avatarInput').value = '';
  try {
    const url = await uploadFile(file, 'avatar');
    state.user.avatar = url;
    renderMyAvatar();
    // сохраняем сразу в аккаунт, как и фон чата/тему — иначе фото
    // визуально «слетает» при обновлении страницы, если человек не
    // дошёл до отдельной кнопки «Сохранить».
    const { user } = await api('/api/me', { method: 'PATCH', body: { avatar: url } });
    state.user = user;
    renderMyAvatar();
    populateProfileViewInfo();
  } catch (e) { alert('Не удалось сохранить фото: ' + e.message); }
});
$('#removeAvatarBtn').addEventListener('click', async () => {
  state.user.avatar = '';
  renderMyAvatar();
  try {
    const { user } = await api('/api/me', { method: 'PATCH', body: { avatar: '' } });
    state.user = user;
    renderMyAvatar();
    populateProfileViewInfo();
  } catch (e) { alert('Не удалось удалить фото: ' + e.message); }
});

$('#wallpaperInput').addEventListener('change', async () => {
  const file = $('#wallpaperInput').files[0];
  if (!file) return;
  $('#wallpaperInput').value = '';
  const url = await uploadFile(file, 'wallpaper');
  await saveWallpaperPref(url);
});

function highlightActiveThemeSwatch() {
  $all('.theme-swatch').forEach((s) => s.classList.toggle('active', s.dataset.themeValue === currentThemePref));
}
$all('.theme-swatch').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const value = btn.dataset.themeValue;
    applyThemePref(value);
    highlightActiveThemeSwatch();
    // сохраняем сразу в аккаунт, а не только при нажатии общей кнопки
    // «Сохранить» в настройках — иначе тема визуально «слетает» при
    // следующем открытии вкладки, если человек забыл сохранить остальное.
    if (state.user) {
      try {
        const { user } = await api('/api/me', { method: 'PATCH', body: { theme: currentThemePref } });
        state.user = user;
      } catch (e) { alert(e.message); }
    }
  });
});


/* ---------------- ВЫБОР ЗНАЧЕНИЯ: стрелочка → подстраница в стиле «Язык» ---------------- */
let choiceReturnKey = 'privacy';
const CHOICES = {
  whoCanMessage: {
    title: 'Кто может писать мне', ret: 'privacy',
    options: [['all', 'Все'], ['contacts', 'Контакты'], ['nobody', 'Никто']],
    note: '«Контакты» — те, кого вы добавили в контакты через профиль. «Никто» — писать вам первым не сможет никто. Если вы сами уже писали человеку первым, он сможет ответить. Заблокированные не смогут писать в любом случае.',
    get: () => ['contacts', 'nobody'].includes((state.user || {}).whoCanMessage) ? state.user.whoCanMessage : 'all',
    set: (v) => savePrivacyField('whoCanMessage', v, refreshChoiceValues),
  },
  whoCanCall: {
    title: 'Кто может звонить мне', ret: 'privacy',
    options: [['all', 'Все'], ['contacts', 'Контакты'], ['nobody', 'Никто']],
    note: '«Контакты» — те, кого вы добавили в контакты через профиль. Заблокированные не смогут звонить в любом случае.',
    get: () => ['contacts', 'nobody'].includes((state.user || {}).whoCanCall) ? state.user.whoCanCall : 'all',
    set: (v) => savePrivacyField('whoCanCall', v, refreshChoiceValues),
  },
  storyAudience: {
    title: 'Кто видит мои истории', ret: 'privacy',
    options: [['all', 'Все'], ['contacts', 'Контакты']],
    note: 'Аудиторию можно изменить и при публикации каждой истории.',
    get: () => loadStoryAudience(),
    set: (v) => { try { localStorage.setItem(STORY_AUD_KEY, v === 'contacts' ? 'contacts' : 'all'); } catch (e) {} },
  },
  appLockTimeout: {
    title: 'Автоблокировка', ret: 'applock',
    options: [['0', 'Сразу'], ['60000', 'Через 1 минуту'], ['300000', 'Через 5 минут'], ['3600000', 'Через 1 час']],
    note: 'Через сколько после выхода из приложения снова потребуется код. При запуске приложения код нужен всегда.',
    get: () => String((appLockCfg() || {}).timeout || 0),
    set: (v) => { const c = appLockCfg(); if (c) { c.timeout = Number(v) || 0; appLockSave(c); } },
  },
};
function choiceLabel(key) {
  const c = CHOICES[key]; const cur = String(c.get());
  const o = c.options.find((x) => x[0] === cur);
  return o ? o[1] : c.options[0][1];
}
function refreshChoiceValues() {
  Object.keys(CHOICES).forEach((k) => { const el = document.getElementById('choiceVal_' + k); if (el) el.textContent = choiceLabel(k); });
}
function openChoicePage(key) {
  const c = CHOICES[key]; if (!c) return;
  choiceReturnKey = c.ret;
  openSettingsSubpage('choice');
  $('#settingsSubTitle').textContent = c.title;
  const cur = String(c.get());
  $('#choiceList').innerHTML = c.options.map(([v, l]) =>
    `<label class="checkbox-row lang-radio-row"><span class="cr-label">${escapeHtml(l)}</span><input type="radio" name="choiceRadio" value="${v}"${v === cur ? ' checked' : ''}></label>`).join('');
  $('#choiceFootnote').textContent = c.note || '';
  $all('#choiceList input[name="choiceRadio"]').forEach((r) => r.addEventListener('change', async () => {
    if (!r.checked) return;
    await c.set(r.value);
    refreshChoiceValues();
  }));
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-choice]');
  if (b) openChoicePage(b.getAttribute('data-choice'));
});

/* ---------------- КОД-ПАРОЛЬ ДЛЯ ВХОДА В ПРИЛОЖЕНИЕ ---------------- */
// Это замок интерфейса на этом устройстве: хэш PIN (PBKDF2 + соль) лежит в localStorage,
// на сервер ничего не уходит. Привязан к аккаунту, при выходе из аккаунта сбрасывается.
const APPLOCK_KEY = 'asteria_applock_v1';
function appLockCfg() { try { return JSON.parse(localStorage.getItem(APPLOCK_KEY) || 'null'); } catch (e) { return null; } }
function appLockSave(c) { try { if (c) localStorage.setItem(APPLOCK_KEY, JSON.stringify(c)); else localStorage.removeItem(APPLOCK_KEY); } catch (e) {} }
async function appLockHash(pin, salt) {
  const enc = new TextEncoder();
  if (window.crypto && crypto.subtle) {
    const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 60000 }, key, 256);
    return Array.from(new Uint8Array(bits)).map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  let h = 5381; const str = salt + ':' + pin; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return 'x' + h;
}
async function appLockCheck(pin) { const c = appLockCfg(); return !!c && (await appLockHash(pin, c.salt)) === c.hash; }

let lockUI = null;
function buildLockUI() {
  if (lockUI) return lockUI;
  const el = document.createElement('div');
  el.id = 'appLockOverlay'; el.className = 'applock hidden';
  el.innerHTML = `<div class="applock-box">
    <div class="applock-ic"><svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10.5" width="14" height="10" rx="3"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5M12 14.5v2"/></svg></div>
    <div class="applock-title"></div><div class="applock-sub"></div>
    <div class="applock-dots"><i></i><i></i><i></i><i></i></div>
    <div class="applock-pad"></div>
    <button type="button" class="applock-link applock-cancel hidden">Отмена</button>
    <button type="button" class="applock-link applock-forgot hidden">Забыли код? Выйти из аккаунта</button>
  </div>`;
  const pad = el.querySelector('.applock-pad');
  ['1','2','3','4','5','6','7','8','9','','0','⌫'].forEach((k) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = k; b.dataset.k = k; if (!k) b.style.visibility = 'hidden'; pad.appendChild(b); });
  document.body.appendChild(el);
  lockUI = { el, title: el.querySelector('.applock-title'), sub: el.querySelector('.applock-sub'), dots: [...el.querySelectorAll('.applock-dots i')],
    box: el.querySelector('.applock-box'), cancel: el.querySelector('.applock-cancel'), forgot: el.querySelector('.applock-forgot'), val: '', onDigit: null };
  pad.addEventListener('click', (e) => { const k = e.target.dataset && e.target.dataset.k; if (k) lockKey(k); });
  document.addEventListener('keydown', (e) => {
    if (el.classList.contains('hidden')) return;
    if (/^[0-9]$/.test(e.key)) lockKey(e.key); else if (e.key === 'Backspace') lockKey('⌫'); else if (e.key === 'Escape' && !lockUI.cancel.classList.contains('hidden')) lockUI.cancel.click();
  });
  lockUI.forgot.addEventListener('click', async () => {
    if (!confirm('Выйти из аккаунта? Код-пароль на этом устройстве будет сброшен.')) return;
    appLockSave(null);
    try { await api('/api/logout', { method: 'POST' }); } catch (e) {}
    location.reload();
  });
  return lockUI;
}
function lockPaintDots() { lockUI.dots.forEach((d, i) => d.classList.toggle('f', i < lockUI.val.length)); }
function lockKey(k) {
  if (!lockUI || lockUI.busy) return;
  if (k === '⌫') lockUI.val = lockUI.val.slice(0, -1);
  else if (lockUI.val.length < 4) lockUI.val += k;
  lockPaintDots();
  if (lockUI.val.length === 4 && lockUI.onDigit) { const v = lockUI.val; lockUI.busy = true; setTimeout(async () => { await lockUI.onDigit(v); lockUI.busy = false; }, 110); }
}
function lockReset(title, sub) { lockUI.val = ''; lockPaintDots(); lockUI.title.textContent = title; lockUI.sub.textContent = sub || ''; }
function lockShake(msg) { lockUI.box.classList.add('shake'); lockUI.sub.textContent = msg || ''; lockUI.sub.classList.add('err'); setTimeout(() => { lockUI.box.classList.remove('shake'); lockUI.sub.classList.remove('err'); lockReset(lockUI.title.textContent, ''); lockUI.sub.textContent = msg || ''; }, 380); }

// Единый запрос PIN. mode: 'unlock' (экран блокировки, не закрывается), 'verify' (подтвердить текущий), 'new' (задать новый, дважды)
function lockPrompt(mode, titleText) {
  buildLockUI();
  return new Promise((resolve) => {
    const ui = lockUI; let first = null, fails = 0, blockedUntil = 0;
    const finish = (v) => { ui.el.classList.add('hidden'); ui.onDigit = null; ui.cancel.onclick = null; resolve(v); };
    ui.el.classList.remove('hidden');
    ui.cancel.classList.toggle('hidden', mode === 'unlock');
    ui.forgot.classList.toggle('hidden', mode !== 'unlock');
    ui.cancel.onclick = () => finish(null);
    lockReset(titleText || (mode === 'new' ? 'Придумайте код' : 'Введите код-пароль'), mode === 'new' ? '4 цифры' : '');
    ui.onDigit = async (v) => {
      if (mode === 'new') {
        if (first === null) { first = v; lockReset('Повторите код', ''); return; }
        if (first === v) return finish(v);
        first = null; lockShake('Коды не совпали'); setTimeout(() => lockReset('Придумайте код', 'Коды не совпали, попробуйте ещё раз'), 400); return;
      }
      if (Date.now() < blockedUntil) { lockShake('Подождите ' + Math.ceil((blockedUntil - Date.now()) / 1000) + ' с'); return; }
      if (await appLockCheck(v)) return finish(v);
      fails++;
      if (fails >= 5) { blockedUntil = Date.now() + 30000; fails = 0; lockShake('Слишком много попыток. Подождите 30 с'); }
      else lockShake('Неверный код');
    };
  });
}

let appLocked = false, appHiddenAt = 0;
async function showAppLock() {
  if (appLocked) return; appLocked = true;
  document.documentElement.classList.add('applock-on');
  await lockPrompt('unlock', 'Введите код-пароль');
  appLocked = false; document.documentElement.classList.remove('applock-on');
}
// Холодный старт: если код включён — закрываем интерфейс сразу, не дожидаясь загрузки данных.
(function () { const c = appLockCfg(); if (c && c.hash) showAppLock(); })();
function appLockOnAuthed(user) {
  const c = appLockCfg();
  if (c && c.uid && user && c.uid !== user.id) appLockSave(null); // замок другого аккаунта
}
function appLockOnNoUser() {
  const c = appLockCfg();
  if (c) appLockSave(null); // вышли/сессия истекла — замок не нужен
  if (lockUI) { lockUI.el.classList.add('hidden'); lockUI.onDigit = null; }
  appLocked = false; document.documentElement.classList.remove('applock-on');
}
document.addEventListener('visibilitychange', () => {
  const c = appLockCfg(); if (!c || !c.hash || !state.user) return;
  if (document.hidden) { appHiddenAt = Date.now(); return; }
  if (appHiddenAt && Date.now() - appHiddenAt >= (c.timeout || 0)) showAppLock();
  appHiddenAt = 0;
});

function refreshAppLockStatus() { const s = $('#appLockStatusValue'); if (s) s.textContent = appLockCfg() ? 'Вкл.' : 'Выкл.'; }
function refreshAppLockPage() {
  const on = !!appLockCfg();
  $('#appLockOffGroup').classList.toggle('hidden', on);
  $('#appLockOnGroups').classList.toggle('hidden', !on);
  refreshChoiceValues(); refreshAppLockStatus();
}
async function appLockSetNew() {
  const pin = await lockPrompt('new', 'Придумайте код');
  if (pin === null) return false;
  const salt = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const prev = appLockCfg();
  appLockSave({ salt, hash: await appLockHash(pin, salt), timeout: prev ? prev.timeout || 0 : 0, uid: state.user && state.user.id });
  return true;
}
$('#appLockEnableBtn').addEventListener('click', async () => { await appLockSetNew(); refreshAppLockPage(); });
$('#appLockChangeBtn').addEventListener('click', async () => {
  if ((await lockPrompt('verify', 'Введите текущий код')) === null) return;
  await appLockSetNew(); refreshAppLockPage();
});
$('#appLockDisableBtn').addEventListener('click', async () => {
  if ((await lockPrompt('verify', 'Введите код, чтобы выключить')) === null) return;
  appLockSave(null); refreshAppLockPage();
});
$('#appLockNowBtn').addEventListener('click', () => showAppLock());
$('#logoutBtn').addEventListener('click', () => appLockSave(null), true);

/* ---------------- ЯЗЫК ИНТЕРФЕЙСА ---------------- */

function highlightActiveLanguageRadio() {
  const ru = $('#langRadioRu');
  const en = $('#langRadioEn');
  if (ru) ru.checked = currentLanguagePref === 'ru';
  if (en) en.checked = currentLanguagePref === 'en';
  const statusEl = $('#languageStatusValue');
  if (statusEl) statusEl.textContent = currentLanguagePref === 'en' ? 'English' : 'Русский';
}
highlightActiveLanguageRadio();

$all('input[name="langRadio"]').forEach((radio) => {
  radio.addEventListener('change', async () => {
    if (!radio.checked) return;
    applyLanguagePref(radio.value);
    // Текст на кнопках нижней панели (Чаты/Звонки/Настройки) поменял длину
    // вместе с языком — плашка-индикатор держит свою ширину/позицию в px,
    // посчитанные под старый текст, и без пересчёта "слетает" при следующем
    // же переключении раздела. Пересчитываем сразу, а не только при
    // переключении вкладок.
    equalizeBottomNavButtonWidths();
    if (typeof moveBottomNavIndicator === 'function') moveBottomNavIndicator(state.activeSection || 'chats', false);
    // Открытая в этот момент подстраница настроек (если есть) сама не
    // перерисуется — обновим её заголовок сразу, чтобы не ждать перехода
    // туда-обратно.
    if (state.activeSection === 'settings' && !$('#settingsSubView').classList.contains('hidden')) {
      const openKey = Object.keys(SETTINGS_SUBPAGES).find((k) => !$('#' + SETTINGS_SUBPAGES[k].el).classList.contains('hidden'));
      if (openKey) $('#settingsSubTitle').textContent = t(SETTINGS_SUBPAGES[openKey].titleKey);
    }
    if (state.user) {
      try {
        const { user } = await api('/api/me', { method: 'PATCH', body: { language: currentLanguagePref } });
        state.user = user;
      } catch (e) { /* язык уже переключился визуально — сохранение в фоне, ошибку молча логируем в консоль */ console.error(e); }
    }
  });
});

// ---------- Рингтон звонка ----------
// "Классический" — встроенный файл (public/ringtones/classic.mp3), "Свой" —
// то, что пользователь сам загрузил (state.user.ringtoneUrl, через
// /api/upload с kind: 'ringtone'). Выбор хранится на сервере (как тема,
// фон чата и т.п.) — значит одинаков на всех устройствах после входа.
const CLASSIC_RINGTONE_URL = '/ringtones/classic.mp3';
function currentRingtoneUrl() {
  if (state.user && state.user.ringtoneType === 'custom' && state.user.ringtoneUrl) return state.user.ringtoneUrl;
  return CLASSIC_RINGTONE_URL;
}
function refreshRingtoneSettingsUI() {
  if (!state.user) return;
  const type = state.user.ringtoneType === 'custom' ? 'custom' : 'classic';
  const classicRadio = $('#ringtoneRadioClassic');
  const customRadio = $('#ringtoneRadioCustom');
  if (classicRadio) classicRadio.checked = type === 'classic';
  if (customRadio) customRadio.checked = type === 'custom';
  $('#uploadRingtoneBtn').classList.toggle('hidden', type !== 'custom');
  $('#ringtoneStatus').textContent = (type === 'custom' && !state.user.ringtoneUrl) ? 'Загрузите файл со своим звуком' : '';
}
$all('input[name="ringtoneRadio"]').forEach((radio) => {
  radio.addEventListener('change', async () => {
    if (!radio.checked) return;
    // Переключение на "Свой", пока файл ещё не загружен, — это ещё не
    // повод отправлять patch на сервер (нечего сохранять и звук не
    // выбран); просто показываем кнопку загрузки и ждём файл.
    if (radio.value === 'custom' && !state.user.ringtoneUrl) {
      refreshRingtoneSettingsUI();
      $('#uploadRingtoneBtn').classList.remove('hidden');
      $('#ringtoneStatus').textContent = 'Загрузите файл со своим звуком';
      return;
    }
    try {
      const { user } = await api('/api/me', { method: 'PATCH', body: { ringtoneType: radio.value } });
      state.user = user;
      refreshRingtoneSettingsUI();
    } catch (e) {
      $('#ringtoneStatus').textContent = e.message || 'Не удалось сохранить';
    }
  });
});
$('#uploadRingtoneBtn').addEventListener('click', () => $('#ringtoneInput').click());
$('#ringtoneInput').addEventListener('change', async () => {
  const file = $('#ringtoneInput').files[0];
  $('#ringtoneInput').value = '';
  if (!file) return;
  $('#ringtoneStatus').textContent = 'Загрузка…';
  try {
    const url = await uploadFile(file, 'ringtone');
    const { user } = await api('/api/me', { method: 'PATCH', body: { ringtoneUrl: url, ringtoneType: 'custom' } });
    state.user = user;
    refreshRingtoneSettingsUI();
    $('#ringtoneStatus').textContent = 'Сохранено ✓';
  } catch (e) {
    $('#ringtoneStatus').textContent = e.message || 'Не удалось загрузить файл';
  }
});
$('#previewRingtoneBtn').addEventListener('click', () => {
  // Прослушать то, что выбрано ПРЯМО СЕЙЧАС на экране (радиокнопка), а не
  // обязательно уже сохранённое на сервере значение — так удобнее сравнить
  // классический со своим перед тем, как переключаться.
  const wantCustom = $('#ringtoneRadioCustom') && $('#ringtoneRadioCustom').checked;
  const url = (wantCustom && state.user && state.user.ringtoneUrl) ? state.user.ringtoneUrl : CLASSIC_RINGTONE_URL;
  try { new Audio(url).play().catch(() => {}); } catch (e) {}
});

// ---------- Звук во время звонка ----------
// У ТОГО, КТО ЗВОНИТ, всегда играют обычные гудки вызова (синтезируются
// через Web Audio — тот самый знакомый "ту-у-у... ту-у-у", как в обычной
// телефонной линии, отдельный аудиофайл для этого не нужен). У ТОГО, КОМУ
// ЗВОНЯТ, играет выбранный рингтон (классический или свой, см. выше).
let ringtoneAudioEl = null;
function startRingtone() {
  stopRingtone();
  try {
    ringtoneAudioEl = new Audio(currentRingtoneUrl());
    ringtoneAudioEl.loop = true;
    ringtoneAudioEl.play().catch(() => {
      // Автовоспроизведение со звуком браузер может заблокировать, если
      // не было недавнего пользовательского жеста — это не критично, само
      // модальное окно "Входящий звонок" и системное push-уведомление
      // (см. sw.js) всё равно показываются.
    });
  } catch (e) { /* не критично */ }
}
function stopRingtone() {
  if (!ringtoneAudioEl) return;
  try { ringtoneAudioEl.pause(); ringtoneAudioEl.currentTime = 0; } catch (e) {}
  ringtoneAudioEl = null;
}
let ringbackAudioCtx = null;
let ringbackTimerId = null;
function startRingback() {
  stopRingback();
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    ringbackAudioCtx = new Ctx();
    const playBeep = () => {
      if (!ringbackAudioCtx) return;
      const osc = ringbackAudioCtx.createOscillator();
      const gain = ringbackAudioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 425; // стандартная частота гудка вызова АТС
      gain.gain.value = 0.18;
      osc.connect(gain).connect(ringbackAudioCtx.destination);
      osc.start();
      osc.stop(ringbackAudioCtx.currentTime + 1); // гудок ~1 секунда
    };
    playBeep();
    ringbackTimerId = setInterval(playBeep, 4000); // повтор: 1с гудок + 3с тишина
  } catch (e) { /* не критично */ }
}
function stopRingback() {
  if (ringbackTimerId) { clearInterval(ringbackTimerId); ringbackTimerId = null; }
  if (ringbackAudioCtx) { try { ringbackAudioCtx.close(); } catch (e) {} ringbackAudioCtx = null; }
}


// Сетка фонов чата: плитка сброса по умолчанию, готовая галерея и плитка
// «Своё фото» — белая, с плюсом по центру, открывает выбор файла с устройства.
async function saveWallpaperPref(cssValue) {
  applyWallpaperPref(cssValue);
  try {
    const { user } = await api('/api/me', { method: 'PATCH', body: { chatWallpaper: cssValue } });
    state.user = user;
  } catch (e) { alert('Не удалось сохранить фон: ' + e.message); }
  renderWallpaperPresets();
}
function renderWallpaperPresets() {
  const el = $('#wallpaperPresets');
  if (!el) return;
  const current = state.user.chatWallpaper || '';
  el.innerHTML = '';

  // Плитка «по умолчанию»
  const resetBtn = document.createElement('button');
  resetBtn.className = 'wallpaper-preset wallpaper-preset-default' + (!current ? ' active' : '');
  resetBtn.style.backgroundImage = "url('/wallpapers/default.webp')";
  resetBtn.title = 'По умолчанию';
  resetBtn.innerHTML = `<span class="wallpaper-preset-label">По умолчанию</span>`;
  resetBtn.addEventListener('click', () => saveWallpaperPref(''));
  el.appendChild(resetBtn);

  // Бесплатная галерея — доступна всем
  FREE_WALLPAPERS.forEach((wp) => {
    const btn = document.createElement('button');
    btn.className = 'wallpaper-preset' + (current === wp.css ? ' active' : '');
    btn.style.backgroundImage = wp.css;
    btn.title = wp.label;
    btn.innerHTML = `<span class="wallpaper-preset-label">${escapeHtml(wp.label)}</span>`;
    btn.addEventListener('click', () => saveWallpaperPref(wp.css));
    el.appendChild(btn);
  });

  // Плитка «Своё фото»: выбор файла с устройства
  const uploadBtn = document.createElement('button');
  uploadBtn.className = 'wallpaper-preset wallpaper-preset-upload';
  uploadBtn.title = 'Загрузить своё фото';
  uploadBtn.innerHTML = `<span class="wallpaper-preset-plus">+</span><span class="wallpaper-preset-label">Своё фото</span>`;
  uploadBtn.addEventListener('click', () => $('#wallpaperInput').click());
  el.appendChild(uploadBtn);
}


// Чекбокс «Скрыть статус в сети».
function refreshHideOnlineCheckbox() {
  const cb = $('#hideOnlineCheckbox');
  const row = $('#hideOnlineRow');
  if (!cb) return;
  cb.checked = !!state.user.hideOnlineStatus;
}
const hideOnlineCb = $('#hideOnlineCheckbox');
if (hideOnlineCb) {
  hideOnlineCb.addEventListener('change', () => {
    // Раньше здесь ничего не сохранялось — переключатель менял только
    // локальный .checked, а на сервер (PATCH /api/me) значение уходило
    // лишь при нажатии кнопки "Сохранить" на СТРАНИЦЕ ПРОФИЛЯ (там, где
    // #saveSettingsBtn). На подстранице "Конфиденциальность" такой кнопки
    // нет, поэтому переключение здесь визуально срабатывало, но при
    // перезагрузке страницы откатывалось — сервер о нём просто не узнавал.
    savePrivacySettings();
  });
}

// Чекбокс «Скрыть отметки о прочтении»: если включена,
// собеседники в личных чатах никогда не увидят синюю точку «прочитано» у
// отправленных вам сообщений, даже если вы их уже открыли (сам счётчик
// непрочитанных у вас при этом продолжает работать как обычно).
function refreshHideReadStatusCheckbox() {
  const cb = $('#hideReadStatusCheckbox');
  const row = $('#hideReadStatusRow');
  if (!cb) return;
  cb.checked = !!state.user.hideReadStatus;
}
const hideReadStatusCb = $('#hideReadStatusCheckbox');
if (hideReadStatusCb) {
  hideReadStatusCb.addEventListener('change', () => {
    savePrivacySettings();
  });
}

// Чекбокс «Разрешить находить меня по логину в поиске» — та же история:
// раньше сохранялся только вместе с формой профиля, здесь ничего не
// сохраняло изменение сразу.
const discoverableCb = $('#discoverableCheckbox');
if (discoverableCb) {
  discoverableCb.addEventListener('change', () => { savePrivacySettings(); });
}

// Отдельная лёгкая функция сохранения ТОЛЬКО настроек приватности — в
// отличие от saveProfileSettings() ниже не трогает displayName/username/
// status. Это важно: те поля на клиенте берутся из #settingsDisplayName и
// т.п., а туда значения попадают только когда пользователь открывал режим
// редактирования профиля (см. setProfileEditMode). Если зайти сразу в
// Настройки → Конфиденциальность, эти инпуты ещё пустые — вызов
// saveProfileSettings() отсюда отправил бы пустой username и сервер бы
// просто отклонил весь запрос (username короче 3 символов), а заодно
// рисковал бы затереть displayName/status, если бы валидация вообще
// пропустила пустые значения. Поэтому шлём только то, что реально
// относится к этой подстранице.
async function savePrivacySettings() {
  try {
    const { user } = await api('/api/me', {
      method: 'PATCH',
      body: {
        discoverable: $('#discoverableCheckbox').checked,
        hideOnlineStatus: $('#hideOnlineCheckbox').checked,
        hideReadStatus: $('#hideReadStatusCheckbox').checked,
      },
    });
    state.user = user;
  } catch (err) {
    // Если сервер отклонил запрос (например, нет связи),
    // возвращаем чекбоксы в состояние, которое реально хранится на сервере,
    // чтобы UI не "врал" о применённой настройке.
    $('#discoverableCheckbox').checked = state.user.discoverable !== false;
    refreshHideOnlineCheckbox();
    refreshHideReadStatusCheckbox();
    alert(err.message);
  }
}

// ---- Дополнительные настройки конфиденциальности ----
async function savePrivacyField(field, value, revert) {
  try {
    const { user } = await api('/api/me', { method: 'PATCH', body: { [field]: value } });
    state.user = user;
  } catch (err) {
    if (revert) revert();
    alert(err.message);
  }
}
async function renderBlockedUsers() {
  const box = $('#blockedUsersList');
  if (!box) return;
  try {
    const { users } = await api('/api/blocks');
    if (!users.length) { box.innerHTML = '<div class="blocked-empty">Список пуст</div>'; return; }
    box.innerHTML = users.map((u) => `<div class="blocked-row" data-uid="${escapeHtml(u.id)}">
      <div class="avatar" style="${u.avatar ? avatarStyle(u) : ''}">${u.avatar ? '' : escapeHtml(initials(u.displayName))}</div>
      <div class="blocked-info"><div class="blocked-name">${escapeHtml(u.displayName)}</div><div class="blocked-login">@${escapeHtml(u.username)}</div></div>
      <button type="button" class="blocked-unblock">Разблокировать</button></div>`).join('');
  } catch (err) {
    box.innerHTML = '<div class="blocked-empty">Не удалось загрузить список</div>';
  }
}
function refreshPrivacyExtras() {
  const u = state.user || {};
  const t = $('#hideTypingCheckbox');
  if (t) t.checked = !!u.hideTyping;
  refreshChoiceValues();
  renderBlockedUsers();
}
(function setupPrivacyExtras() {
  const t = $('#hideTypingCheckbox'), list = $('#blockedUsersList');
  if (t) t.addEventListener('change', () => savePrivacyField('hideTyping', t.checked, refreshPrivacyExtras));
  if (list) list.addEventListener('click', async (e) => {
    const btn = e.target.closest('.blocked-unblock');
    if (!btn) return;
    const row = btn.closest('.blocked-row');
    btn.disabled = true;
    try { await api('/api/blocks/' + encodeURIComponent(row.dataset.uid), { method: 'DELETE' }); await renderBlockedUsers(); }
    catch (err) { btn.disabled = false; alert(err.message); }
  });
})();

async function saveProfileSettings() {
  $('#settingsError').textContent = '';
  const patch = {
    displayName: $('#settingsDisplayName').value.trim(),
    username: $('#settingsUsername').value.trim(),
    status: $('#settingsStatus').value.trim(),
    avatar: state.user.avatar || '',
    theme: currentThemePref,
    discoverable: $('#discoverableCheckbox').checked,
    hideOnlineStatus: $('#hideOnlineCheckbox').checked,
    hideReadStatus: $('#hideReadStatusCheckbox').checked,
  };
  try {
    const { user } = await api('/api/me', { method: 'PATCH', body: patch });
    state.user = user;
    renderMyAvatar();
    populateProfileViewInfo();
    loadConversations();
    return true;
  } catch (err) { $('#settingsError').textContent = err.message; return false; }
}
// Кнопка #saveSettingsBtn убрана из разметки (см. index.html) — сохранение
// профиля теперь всегда идёт через "Готово" в шапке (#profileEditToggleBtn
// чуть выше), которая и сохраняет, и закрывает режим редактирования.
$all('.password-toggle-eye').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = $('#' + btn.dataset.toggle);
    if (!input) return;
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.textContent = showing ? '👁' : '🙈';
  });
});

const newPasswordEl = $('#newPasswordInput');
if (newPasswordEl) {
  newPasswordEl.addEventListener('input', () => {
    const val = newPasswordEl.value;
    const bars = $all('#passwordStrength span');
    let score = 0;
    if (val.length >= 4) score++;
    if (val.length >= 8) score++;
    if (/[0-9]/.test(val) && /[a-zA-Zа-яА-Я]/.test(val)) score++;
    if (/[^a-zA-Zа-яА-Я0-9]/.test(val) || val.length >= 12) score++;
    const cls = score <= 1 ? 'on-weak' : score <= 2 ? 'on-mid' : 'on-strong';
    bars.forEach((b, i) => { b.className = (i < score && val) ? cls : ''; });
  });
}

$('#changePasswordBtn').addEventListener('click', async () => {
  $('#passwordError').textContent = '';
  const currentPassword = $('#currentPasswordInput').value;
  const newPassword = $('#newPasswordInput').value;
  try {
    await api('/api/me/password', { method: 'POST', body: { currentPassword, newPassword } });
    $('#currentPasswordInput').value = '';
    $('#newPasswordInput').value = '';
    $all('#passwordStrength span').forEach((b) => b.className = '');
    $('#passwordError').style.color = 'var(--accent-2)';
    $('#passwordError').textContent = 'Пароль изменён ✓';
  } catch (err) {
    $('#passwordError').style.color = 'var(--danger)';
    $('#passwordError').textContent = err.message;
  }
});

/* ---------------- ССЫЛКИ И QR (шаринг звонков/профилей/групп/каналов) ---------------- */

function buildInviteLink(code) { return `${publicOrigin()}/j/${code}`; }
function buildProfileLink(username) { return `${publicOrigin()}/u/${username}`; }

function renderQrInto(el, text) {
  el.innerHTML = '';
  if (window.AsteriaQR) {
    try { el.innerHTML = window.AsteriaQR.toSVG(text, 5, 3); }
    catch (e) { el.textContent = ''; }
  }
}

function openShareModal(title, link) {
  $('#shareModalTitle').textContent = title || 'Поделиться';
  $('#shareModalLink').textContent = link;
  renderQrInto($('#shareModalQr'), link);
  $('#shareModalCopyBtn').textContent = 'Скопировать ссылку';
  $('#shareModalCopyBtn').onclick = () => {
    navigator.clipboard.writeText(link).catch(() => {});
    $('#shareModalCopyBtn').textContent = 'Скопировано!';
    setTimeout(() => { $('#shareModalCopyBtn').textContent = 'Скопировать ссылку'; }, 1500);
  };
  const nativeBtn = $('#shareModalNativeBtn');
  if (navigator.share) {
    nativeBtn.classList.remove('hidden');
    nativeBtn.onclick = () => navigator.share({ title, url: link }).catch(() => {});
  } else {
    nativeBtn.classList.add('hidden');
  }
  showModal('#shareModal');
}

/* ---------------- ПОЛНОЭКРАННЫЙ ФЛОУ: создать чат / группу / канал ---------------- */

let composeStack = ['composeMenuScreen'];
let composeFoundUser = null;

function composeShowScreen(id) {
  $all('.compose-screen').forEach((s) => s.classList.add('hidden'));
  $('#' + id).classList.remove('hidden');
}

function openComposeFlow() {
  composeStack = ['composeMenuScreen'];
  composeShowScreen('composeMenuScreen');
  $('#composeFlow').classList.remove('hidden');
  $('#composeUserSearchInput').value = '';
  renderComposeUserResults([]);
  $('#composeChannelsList').classList.add('hidden');
  $('#composeGroupName').value = '';
  $('#composeGroupForm').classList.remove('hidden');
  $('#composeGroupDone').classList.add('hidden');
  $('#composeChannelName').value = '';
  $('#composeChannelForm').classList.remove('hidden');
  $('#composeChannelDone').classList.add('hidden');
}
function closeComposeFlow() { $('#composeFlow').classList.add('hidden'); }

$('#newChatBtn').addEventListener('click', openComposeFlow);
$('#composeCloseBtn').addEventListener('click', closeComposeFlow);
$all('.compose-list-item[data-compose-target]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.composeTarget;
    composeStack.push(target);
    composeShowScreen(target);
  });
});
$all('[data-compose-back]').forEach((btn) => {
  btn.addEventListener('click', () => {
    composeStack.pop();
    composeShowScreen(composeStack[composeStack.length - 1] || 'composeMenuScreen');
  });
});

// ---- Создать чат: поиск по логину/почте, локальное имя контакта ----
function renderComposeUserResults(users) {
  const usersEl = $('#composeUserResults');
  usersEl.innerHTML = '';
  if (!users.length) {
    const q = $('#composeUserSearchInput').value.trim();
    usersEl.innerHTML = `<div class="chat-header-sub" style="padding:8px;">${q.length < 2 ? 'Введите минимум 2 символа логина или почты' : 'Никто не найден — либо неверно, либо человек скрыл поиск по себе'}</div>`;
    return;
  }
  users.forEach((u) => {
    state.usersById[u.id] = u;
    const row = document.createElement('div');
    row.className = 'user-row';
    row.innerHTML = `<div class="avatar" style="${u.avatar ? avatarStyle(u) : ''}">${u.avatar ? '' : initials(u.displayName)}</div><div><div>${escapeHtml(u.displayName)}${verifiedBadge(u)}</div><div class="chat-header-sub">@${escapeHtml(u.username)}</div></div>`;
    row.addEventListener('click', () => {
      composeFoundUser = u;
      $('#composeContactPreview').innerHTML = `<div class="avatar" style="${u.avatar ? avatarStyle(u) : ''}">${u.avatar ? '' : initials(u.displayName)}</div><div><div>${escapeHtml(u.displayName)}${verifiedBadge(u)}</div><div class="chat-header-sub">@${escapeHtml(u.username)}</div></div>`;
      $('#composeNicknameInput').value = '';
      composeStack.push('composeAddContactScreen');
      composeShowScreen('composeAddContactScreen');
    });
    usersEl.appendChild(row);
  });
}

let composeSearchDebounce = null;
$('#composeUserSearchInput').addEventListener('input', () => {
  clearTimeout(composeSearchDebounce);
  const q = $('#composeUserSearchInput').value.trim();
  if (q.length < 2) { renderComposeUserResults([]); return; }
  composeSearchDebounce = setTimeout(async () => {
    try {
      const { users } = await api(`/api/users?q=${encodeURIComponent(q)}`);
      renderComposeUserResults(users.filter((u) => u.id !== state.user.id));
    } catch (e) { renderComposeUserResults([]); }
  }, 300);
});

$('#composeShowChannelsBtn').addEventListener('click', async () => {
  const listEl = $('#composeChannelsList');
  if (!listEl.classList.contains('hidden')) { listEl.classList.add('hidden'); return; }
  const { channels } = await api('/api/channels');
  listEl.innerHTML = '';
  channels.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'channel-row';
    const subscribed = (c.participants || []).includes(state.user.id);
    row.innerHTML = `<div class="avatar" style="${c.avatar ? avatarStyle(c) : ''}">${c.avatar ? '' : initials(c.name)}</div><div>${escapeHtml(c.name)}${verifiedBadge(c)} 📢${subscribed ? ' · вы подписаны' : ''}</div>`;
    row.addEventListener('click', async () => {
      if (!subscribed) await api(`/api/conversations/${c.id}/subscribe`, { method: 'POST' });
      closeComposeFlow();
      await loadConversations();
      openConversation(c.id);
    });
    listEl.appendChild(row);
  });
  listEl.classList.remove('hidden');
});

$('#composeAddContactBtn').addEventListener('click', async () => {
  if (!composeFoundUser) return;
  const { conversation } = await api('/api/conversations', { method: 'POST', body: { type: 'dm', userId: composeFoundUser.id } });
  const nickname = $('#composeNicknameInput').value.trim();
  if (nickname) await api(`/api/conversations/${conversation.id}/nickname`, { method: 'POST', body: { nickname } });
  closeComposeFlow();
  await loadConversations();
  openConversation(conversation.id);
});

// ---- Создать группу ----
$('#composeCreateGroupBtn').addEventListener('click', async () => {
  const name = $('#composeGroupName').value.trim();
  if (!name) return;
  const { conversation } = await api('/api/conversations', { method: 'POST', body: { type: 'group', name } });
  await loadConversations();
  const link = buildInviteLink(conversation.inviteCode);
  $('#composeGroupInviteLink').textContent = link;
  renderQrInto($('#composeGroupQr'), link);
  $('#composeGroupForm').classList.add('hidden');
  $('#composeGroupDone').classList.remove('hidden');
  $('#composeCopyGroupLinkBtn').onclick = () => {
    navigator.clipboard.writeText(link).catch(() => {});
    $('#composeCopyGroupLinkBtn').textContent = 'Скопировано!';
    setTimeout(() => { $('#composeCopyGroupLinkBtn').textContent = 'Скопировать ссылку'; }, 1500);
  };
  $('#composeShareGroupBtn').onclick = () => openShareModal(name, link);
  $('#composeGroupOpenBtn').onclick = () => { closeComposeFlow(); openConversation(conversation.id); };
});

// ---- Создать канал ----
$('#composeCreateChannelBtn').addEventListener('click', async () => {
  const name = $('#composeChannelName').value.trim();
  if (!name) return;
  const { conversation } = await api('/api/conversations', { method: 'POST', body: { type: 'channel', name } });
  await loadConversations();
  const link = buildInviteLink(conversation.inviteCode);
  $('#composeChannelInviteLink').textContent = link;
  renderQrInto($('#composeChannelQr'), link);
  $('#composeChannelForm').classList.add('hidden');
  $('#composeChannelDone').classList.remove('hidden');
  $('#composeCopyChannelLinkBtn').onclick = () => {
    navigator.clipboard.writeText(link).catch(() => {});
    $('#composeCopyChannelLinkBtn').textContent = 'Скопировано!';
    setTimeout(() => { $('#composeCopyChannelLinkBtn').textContent = 'Скопировать ссылку'; }, 1500);
  };
  $('#composeShareChannelBtn').onclick = () => openShareModal(name, link);
  $('#composeChannelOpenBtn').onclick = () => { closeComposeFlow(); openConversation(conversation.id); };
});

/* ---------------- ГЛУБОКИЕ ССЫЛКИ: приглашение в группу/канал, профиль ---------------- */

async function handleDeepLinkIfPresent() {
  const inviteMatch = location.pathname.match(/^\/j\/([^/]+)$/);
  const profileMatch = location.pathname.match(/^\/u\/([^/]+)$/);
  const qrMatch = location.pathname.match(/^\/qr\/([^/]+)$/);
  if (!inviteMatch && !profileMatch && !qrMatch) return;
  history.replaceState({}, '', '/');
  if (inviteMatch) {
    try {
      const { preview } = await api(`/api/invite/${inviteMatch[1]}`);
      const kindWord = preview.type === 'group' ? 'группу' : 'канал';
      if (preview.alreadyMember) {
        await loadConversations();
        openConversation(preview.id);
        return;
      }
      if (!confirm(`Вступить в ${kindWord} «${preview.name}» (${preview.memberCount} участников)?`)) return;
      await api(`/api/invite/${inviteMatch[1]}/join`, { method: 'POST' });
      await loadConversations();
      openConversation(preview.id);
    } catch (e) { alert(e.message || 'Ссылка недействительна или устарела'); }
  } else if (profileMatch) {
    try {
      const { users } = await api(`/api/users?q=${encodeURIComponent(profileMatch[1])}`);
      const exact = users.find((u) => u.username === profileMatch[1]);
      if (exact) openProfilePage(exact.id);
      else alert('Пользователь не найден');
    } catch (e) { alert('Пользователь не найден'); }
  } else if (qrMatch) {
    // Сюда попадают, уже будучи авторизованными (эта функция вызывается
    // только после onAuthed/checkSession) — значит это устройство сканирует
    // QR ДРУГОГО, ещё не вошедшего устройства. Подтверждаем вход по коду.
    await confirmQrLoginTicket(qrMatch[1]);
  }
}

// Подтвердить тикет входа по QR (вызывается и при переходе по /qr/<id>, и
// при ручном вводе кода в Настройки → Устройства).
async function confirmQrLoginTicket(ticketId) {
  if (!confirm('Подтвердить вход в аккаунт на другом устройстве?')) return;
  try {
    await api(`/api/qr-login/${encodeURIComponent(ticketId)}/confirm`, { method: 'POST' });
    alert('Готово — другое устройство сейчас войдёт в аккаунт автоматически.');
  } catch (e) {
    alert(e.message || 'Код недействителен или уже устарел');
  }
}

/* ---------------- STORIES ---------------- */

// Точечно подгружает и кеширует профиль по ID — вместо публичного каталога всех
// пользователей. Используется для отображения имён людей, с которыми уже есть
// общий контекст (история, звонок, участник канала), а не для поиска/просмотра.
async function ensureUserCached(userId) {
  if (!userId) return null;
  if (state.usersById[userId]) return state.usersById[userId];
  try {
    const { user } = await api(`/api/users/${userId}`);
    state.usersById[userId] = user;
    return user;
  } catch (e) {
    return null;
  }
}

async function loadStories() {
  const { stories } = await api('/api/stories');
  state.usersById[state.user.id] = state.user;
  const authorIds = [...new Set(stories.map((s) => s.userId))];
  await Promise.all(authorIds.map(ensureUserCached));
  renderStories(stories);
}

// Просмотренные истории запоминаются на устройстве (по аккаунту): кольцо серое,
// а автор уходит в конец ленты — новые истории всегда впереди.
const storySeenKey = () => 'asteria_seen_stories_' + (state.user ? state.user.id : '');
function storySeenSet() { try { return new Set(JSON.parse(localStorage.getItem(storySeenKey()) || '[]')); } catch (e) { return new Set(); } }
function markStorySeen(id) {
  if (!id || !state.user) return;
  const set = storySeenSet(); if (set.has(id)) return;
  set.add(id);
  try { localStorage.setItem(storySeenKey(), JSON.stringify(Array.from(set).slice(-600))); } catch (e) {}
}
function storyGroupSeen(stories, seen) { return !!stories.length && stories.every((s) => (seen || storySeenSet()).has(s.id)); }
function refreshStoryRings() {
  if (!state.user || !state.storyGroups) return;
  renderStories(state.storyGroups.flatMap((g) => g.stories));
}

function renderStories(stories) {
  const seenSet = storySeenSet();
  const byUser = {};
  stories.forEach((s) => { (byUser[s.userId] = byUser[s.userId] || []).push(s); });
  // Порядок просмотра: сначала мои, затем остальные авторы — по концу ленты просмотр
  // автоматически переходит к следующему человеку.
  const newest = (uid) => Math.max(...byUser[uid].map((s) => s.createdAt || 0));
  state.storyGroups = Object.keys(byUser)
    .sort((a, b) => {
      if (a === state.user.id) return -1;
      if (b === state.user.id) return 1;
      const sa = storyGroupSeen(byUser[a], seenSet), sb = storyGroupSeen(byUser[b], seenSet);
      if (sa !== sb) return sa ? 1 : -1;          // непросмотренные — вперёд
      return newest(b) - newest(a);               // внутри группы — самые свежие первыми
    })
    .map((uid) => ({ user: state.usersById[uid] || { id: uid, displayName: '?' }, stories: byUser[uid].sort((x, y) => x.createdAt - y.createdAt) }));
  const el = $('#storiesStrip');
  el.innerHTML = '';

  const avatarHtml = (u, ring, plus, seen) => `<div class="story-avatar${ring ? ' has-story' : ''}${ring && seen ? ' seen' : ''}"><div class="story-avatar-inner" style="${u.avatar ? avatarStyle(u) : ''}">${u.avatar ? '' : initials(u.displayName || '?')}</div>${plus ? '<i class="story-plus" title="Добавить историю">+</i>' : ''}</div>`;

  // «Моя история»: аватар с кружком «+» (добавить), а если история уже есть — ещё и кольцо вокруг аватара.
  const mine = document.createElement('div');
  const mineHasStory = !!byUser[state.user.id];
  const mineSeen = mineHasStory && storyGroupSeen(byUser[state.user.id], seenSet);
  mine.className = 'story-item story-item-mine' + (mineHasStory ? ' has-story' : '');
  mine.dataset.uid = state.user.id;
  mine.innerHTML = `${avatarHtml(state.user, mineHasStory, true, mineSeen)}<span class="story-name">${escapeHtml(state.user.displayName || 'Вы')}</span>`;
  mine.addEventListener('click', (e) => {
    if (e.target.closest('.story-plus') || !mineHasStory) { openCreateStoryModal(); return; }
    viewStories(byUser[state.user.id], state.user, mine.querySelector('.story-avatar'));
  });
  el.appendChild(mine);
  // Мой аватар в историях — первое, что рисуется при открытии страницы
  // чатов, ещё до того как WebView успевает "прогреть" композитор. У
  // background-image (в отличие от <img>) нет события load, поэтому
  // WebView иногда декодирует картинку асинхронно и не перерисовывает уже
  // вставленный элемент — аватар остаётся видимым как затемнённая
  // заглушка, пока пользователь не коснётся экрана (это и триггерит
  // перерисовку). Форсируем перерисовку сами, как только картинка реально
  // готова, не дожидаясь касания.
  if (state.user.avatar) preloadAvatarAndRepaint(mine.querySelector('.story-avatar-inner'), state.user.avatar);

  state.storyGroups.forEach((g) => {
    const uid = g.user.id;
    if (uid === state.user.id) return;
    const u = state.usersById[uid] || { displayName: '?' };
    const item = document.createElement('div');
    item.className = 'story-item has-story';
    item.dataset.uid = uid;
    item.innerHTML = `${avatarHtml(u, true, false, storyGroupSeen(byUser[uid], seenSet))}<span class="story-name">${escapeHtml(u.displayName || '?')}</span>`;
    item.addEventListener('click', () => viewStories(byUser[uid], u, item.querySelector('.story-avatar')));
    el.appendChild(item);
  });

  renderMiniStories();
}

// Свёрнутые истории: до трёх аватаров, наложенных друг на друга, рядом со словом «Чаты»
// (показываются, когда список чатов прокручен вниз). Тап по ним НЕ открывает историю, а
// прокручивает список чатов наверх — истории разворачиваются, и уже в развёрнутом
// виде открываются по тапу (см. setupStoriesCollapseOnScroll).
function renderMiniStories() {
  const source = $('#storiesStrip');
  const miniEl = $('#miniStories');
  if (!source || !miniEl) return;
  miniEl.innerHTML = '';
  // Мой («+») — самый верхний в стопке, остальные выглядывают из-под него слева.
  const items = Array.from(source.querySelectorAll('.story-item')).slice(0, 3).reverse();
  items.forEach((item) => {
    const inner = item.querySelector('.story-avatar-inner');
    if (!inner) return;
    const mini = document.createElement('div');
    const isMineNoStory = item.classList.contains('story-item-mine') && !item.classList.contains('has-story');
    mini.className = 'mini-story-avatar' + (isMineNoStory ? ' mini-add' : '');
    const hasPhoto = !!inner.style.backgroundImage;
    mini.innerHTML = `<div class="mini-story-avatar-inner" style="${inner.getAttribute('style') || ''}">${hasPhoto ? '' : (isMineNoStory ? '+' : inner.textContent)}</div>`;
    miniEl.appendChild(mini);
  });
}

// Выставляется в setupStoriesCollapseOnScroll: плавно разворачивает ленту историй.
let storiesExpand = null;
function scrollChatsToTop() {
  if (storiesExpand) storiesExpand();
  [$('#convList'), $('#chatsSearchResults')].filter(Boolean).forEach((l) => {
    if (l.offsetParent !== null) l.scrollTo({ top: 0, behavior: 'smooth' });
  });
}
$('#miniStories').addEventListener('click', scrollChatsToTop);

// Сворачивание ленты историй — «вложенная прокрутка», как у сворачивающейся шапки:
//   • пока лента не свёрнута, жест/колесо СНАЧАЛА тратятся на её сворачивание
//     (ровно 1 пиксель жеста = 1 пиксель высоты ленты), и только потом начинает
//     прокручиваться сам список;
//   • при прокрутке вверх наоборот: сначала список доезжает до верха, потом
//     разворачивается лента.
// Поэтому содержимое всегда движется со скоростью пальца: ничего не «ускоряется»,
// не прыгает и не зависит от запаздывающего сглаживания, а scrollTop списка не
// пересчитывается при изменении его высоты (раньше именно это давало скачки).
// Отпустили на полпути — лента плавно (ease-out, 220 мс) доезжает до ближайшего края
// с учётом направления жеста. Прогресс 0…1 пишется в CSS-переменную --sp только на
// шапку и ленту (а не на весь #sidebar), чтобы не пересчитывать стили строк чатов.
function setupStoriesCollapseOnScroll() {
  const sidebar = $('#sidebar');
  const strip = $('#storiesStrip');
  const top = sidebar && sidebar.querySelector('.sidebar-top');
  const lists = [$('#convList'), $('#chatsSearchResults')].filter(Boolean);
  if (!sidebar || !strip || !top) return;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let H = 0;            // полная высота ленты, px
  let c = 0;            // сколько уже свёрнуто, px (0…H)
  let anim = 0, snapTimer = 0, touching = false, lastDir = 0, lastWheel = 0;
  let lastSp = -1;

  const curList = () => lists.find((l) => l.offsetParent !== null) || null;

  function measure() {
    // Высота ленты в развёрнутом виде; в свёрнутом/сворачивающемся состоянии не трогаем,
    // иначе обрезанная высота подменила бы настоящую.
    if (c > 0.5) return;
    const h = strip.scrollHeight;
    if (Math.abs(h - H) > 1) {
      H = h;
      strip.style.setProperty('--strip-h', h + 'px');
    }
  }

  function paint() {
    const sp = H > 0 ? Math.max(0, Math.min(1, c / H)) : 0;
    const v = sp.toFixed(4);
    if (v === lastSp) return;
    lastSp = v;
    strip.style.setProperty('--sp', v);
    top.style.setProperty('--sp', v);
    sidebar.classList.toggle('stories-collapsed', sp > 0.6);
  }
  function setC(v) {
    c = Math.max(0, Math.min(H, v));
    paint();
  }
  function stopAnim() { if (anim) { cancelAnimationFrame(anim); anim = 0; } }
  function animateTo(target) {
    stopAnim();
    const from = c;
    if (reduceMotion || Math.abs(from - target) < 0.5) { setC(target); return; }
    const t0 = performance.now(), dur = 220;
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur);
      setC(from + (target - from) * (1 - Math.pow(1 - t, 3)));
      anim = t < 1 ? requestAnimationFrame(step) : 0;
    };
    anim = requestAnimationFrame(step);
  }
  // Доезжаем до ближайшего края; если жест был в сторону сворачивания — порог 25%, в сторону разворота — 75%.
  function settle() {
    clearTimeout(snapTimer);
    if (!H || c <= 0.5 || c >= H - 0.5) return;
    const k = lastDir > 0 ? 0.25 : lastDir < 0 ? 0.75 : 0.5;
    animateTo(c / H >= k ? H : 0);
  }
  function scheduleSettle(ms) { clearTimeout(snapTimer); snapTimer = setTimeout(() => { if (!touching) settle(); }, ms); }

  // Сворачивать есть что, только если список вообще прокручивается (или лента уже свёрнута и её надо вернуть).
  const collapsible = (list) => c > 0.5 || list.scrollHeight > list.clientHeight + 1;

  // dy > 0 — содержимое едет вверх (прокрутка вниз). Возвращает true, если лента «съела» движение.
  function consume(list, dy) {
    if (!H || !list || list.offsetParent === null) return false;
    if (dy > 0 && c < H && list.scrollTop <= 0 && collapsible(list)) { lastDir = 1; stopAnim(); setC(c + dy); return true; }
    if (dy < 0 && c > 0 && list.scrollTop <= 0) { lastDir = -1; stopAnim(); setC(c + dy); return true; }
    return false;
  }

  // ---- Касания ----
  let startX = 0, startY = 0, lastY = 0, axis = '', tList = null;
  function onTouchStart(e) {
    if (e.touches.length !== 1) { axis = 'x'; return; }
    touching = true; clearTimeout(snapTimer); stopAnim(); measure();
    startX = e.touches[0].clientX; lastY = startY = e.touches[0].clientY; axis = ''; tList = e.currentTarget === strip ? curList() : e.currentTarget;
  }
  function onTouchMove(e) {
    if (axis === 'x' || !tList) return;
    const t = e.touches[0];
    if (!axis) {
      const ax = Math.abs(t.clientX - startX), ay = Math.abs(t.clientY - startY);
      if (ax < 6 && ay < 6) return;
      axis = ax > ay ? 'x' : 'y';
      if (axis === 'x') return;
    }
    const dy = lastY - t.clientY; lastY = t.clientY;
    if (dy && consume(tList, dy) && e.cancelable) e.preventDefault();
  }
  function onTouchEnd() { touching = false; axis = ''; scheduleSettle(30); }
  [...lists, strip].forEach((el) => {
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
  });

  // ---- Колесо / трекпад ----
  function onWheel(e) {
    if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    measure();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const list = e.currentTarget === strip ? curList() : e.currentTarget;
    lastWheel = performance.now();
    if (consume(list, dy)) { e.preventDefault(); scheduleSettle(160); }
  }
  [...lists, strip].forEach((el) => el.addEventListener('wheel', onWheel, { passive: false }));

  // ---- Список доехал до верха сам (инерция, клавиатура, «наверх»): плавно разворачиваем ленту ----
  lists.forEach((list) => list.addEventListener('scroll', () => {
    if (list.scrollTop <= 0 && c > 0.5 && !touching && performance.now() - lastWheel > 250) { lastDir = -1; animateTo(0); }
  }, { passive: true }));

  storiesExpand = () => { measure(); lastDir = -1; animateTo(0); };

  // Историй стало больше/меньше или сменился размер окна — пересчёт.
  const recalc = () => { measure(); if (c > H) setC(H); else paint(); };
  window.addEventListener('resize', recalc);
  new MutationObserver(recalc).observe(strip, { childList: true, subtree: true });
  measure();
  paint();
}
setupStoriesCollapseOnScroll();

/* ---- Общие хелперы для историй (создание и просмотр) ---- */

const STORY_TEXT_COLORS = ['#ffffff', '#000000', '#ff5c6c', '#ffb020', '#ffe14d', '#3ddc84', '#4fb0ff', '#b08cff'];
const STORY_IMAGE_MS = 5000;

// Размеры текста хранятся «как на кадре шириной 360px» и масштабируются
// единицами контейнера (cqw) — поэтому текст одинаково выглядит и на странице
// создания, и в полноэкранном просмотре, на любом экране.
function storyTextStyle(t) {
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  };
  const color = t.color || '#ffffff';
  const parts = [
    `left:${(t.x * 100).toFixed(2)}%`,
    `top:${(t.y * 100).toFixed(2)}%`,
    `font-size:${((t.size || 28) / 360 * 100).toFixed(3)}cqw`,
  ];
  if (t.bg) parts.push(`background:${color}`, `color:${lum(color) > 0.6 ? '#000' : '#fff'}`);
  else parts.push(`color:${color}`);
  return parts.join(';');
}

function storyLinkLabel(link) {
  if (!link) return '';
  if (link.label) return link.label;
  try { return new URL(link.url).hostname.replace(/^www\./, ''); } catch (e) { return link.url; }
}

function storyAgo(ts) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин назад`;
  return `${Math.floor(m / 60)} ч назад`;
}

/* ---- Просмотр: полноэкранный ---- */

let storyV = null;

let storyOrigin = null;   // откуда «вырос» просмотрщик (аватар в ленте или в профиле)
let storyCloseSeq = 0;

function storyOriginPoint(el) {
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: Math.max(r.width, r.height) / 2 };
}
function storyReach(pt) {
  const w = window.innerWidth, h = window.innerHeight;
  return Math.hypot(Math.max(pt.x, w - pt.x), Math.max(pt.y, h - pt.y)) + 8;
}
const storyReducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function viewStories(stories, user, originEl) {
  const groups = state.storyGroups || [];
  let gi = groups.findIndex((g) => g.user && g.user.id === user.id);
  if (gi < 0) { state.storyGroups = groups.concat([{ user, stories }]); gi = state.storyGroups.length - 1; }
  closeStoryViewer(true);
  const page = $('#storyViewerPage');
  document.body.appendChild(page);
  page.classList.remove('hidden');
  document.documentElement.classList.add('story-fs-open');
  storyV = { gi, idx: 0, paused: false, holds: new Set(), elapsed: 0, last: 0, raf: 0, video: null, frame: null };
  renderStorySlide();
  // Анимация открытия: круг раскрывается из аватара, на который нажали.
  storyOrigin = { el: originEl || null, uid: user.id };
  const pt = storyOriginPoint(originEl);
  if (pt && page.animate && !storyReducedMotion()) {
    const from = `circle(${pt.r}px at ${pt.x}px ${pt.y}px)`;
    const to = `circle(${storyReach(pt)}px at ${pt.x}px ${pt.y}px)`;
    page.animate([{ clipPath: from, opacity: .35 }, { clipPath: to, opacity: 1 }], { duration: 440, easing: 'cubic-bezier(.22,.82,.24,1)' });
    const stage = $('#storyViewer');
    if (stage.animate) stage.animate([{ transform: 'scale(.82)' }, { transform: 'scale(1)' }], { duration: 440, easing: 'cubic-bezier(.22,.82,.24,1)' });
  } else if (page.animate && !storyReducedMotion()) {
    page.animate([{ opacity: 0, transform: 'scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out' });
  }
}

function finishCloseStoryViewer(silent) {
  const page = $('#storyViewerPage');
  if (!page) return;
  page.classList.add('hidden');
  $('#storyViewer').innerHTML = '';
  document.documentElement.classList.remove('story-fs-open');
  if (!silent) { try { if (document.activeElement) document.activeElement.blur(); } catch (e) {} }
}

function closeStoryViewer(silent) {
  storyCloseSeq++;
  const seq = storyCloseSeq;
  if (storyV && storyV.raf) cancelAnimationFrame(storyV.raf);
  if (storyV && storyV.video) { try { storyV.video.pause(); } catch (e) {} }
  const wasOpen = !!storyV;
  storyV = null;
  if (wasOpen) setTimeout(refreshStoryRings, 340);
  const page = $('#storyViewerPage');
  if (!page) return;
  try { page.getAnimations().forEach((an) => an.cancel()); } catch (e) {}
  // Закрытие с анимацией: круг сжимается обратно в аватар (если он ещё на экране).
  if (!silent && wasOpen && page.animate && !storyReducedMotion() && !page.classList.contains('hidden')) {
    const origin = storyOrigin && (storyOrigin.el && storyOrigin.el.isConnected ? storyOrigin.el
      : document.querySelector(`#storiesStrip .story-item[data-uid="${storyOrigin.uid}"] .story-avatar`));
    const pt = storyOriginPoint(origin);
    const frames = pt
      ? [{ clipPath: `circle(${storyReach(pt)}px at ${pt.x}px ${pt.y}px)`, opacity: 1 }, { clipPath: `circle(${pt.r}px at ${pt.x}px ${pt.y}px)`, opacity: .2 }]
      : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.96)' }];
    const an = page.animate(frames, { duration: pt ? 300 : 180, easing: 'cubic-bezier(.4,0,.6,1)' });
    const done = () => { if (seq === storyCloseSeq) finishCloseStoryViewer(false); };
    an.onfinish = done; an.oncancel = () => {};
    return;
  }
  finishCloseStoryViewer(silent);
}

function storyHold(reason, on) {
  if (!storyV) return;
  if (on) storyV.holds.add(reason); else storyV.holds.delete(reason);
  const paused = storyV.holds.size > 0;
  if (paused === storyV.paused) return;
  storyV.paused = paused;
  if (storyV.video) { try { paused ? storyV.video.pause() : storyV.video.play().catch(() => {}); } catch (e) {} }
  if (storyV.frame) storyV.frame.classList.toggle('paused', paused);
}

function storyStep(delta) {
  if (!storyV) return;
  const groups = state.storyGroups;
  const g = groups[storyV.gi];
  let idx = storyV.idx + delta;
  if (idx >= g.stories.length) {
    if (storyV.gi + 1 < groups.length) { storyV.gi += 1; storyV.idx = 0; renderStorySlide(); }
    else closeStoryViewer();
    return;
  }
  if (idx < 0) {
    if (storyV.gi > 0) { storyV.gi -= 1; storyV.idx = groups[storyV.gi].stories.length - 1; renderStorySlide(); }
    else { storyV.elapsed = 0; if (storyV.video) storyV.video.currentTime = 0; }
    return;
  }
  storyV.idx = idx;
  renderStorySlide();
}

function renderStorySlide() {
  const v = storyV;
  if (!v) return;
  if (v.raf) cancelAnimationFrame(v.raf);
  const group = state.storyGroups[v.gi];
  const stories = group.stories;
  if (!stories.length) { closeStoryViewer(); return; }
  if (v.idx >= stories.length) v.idx = stories.length - 1;
  const s = stories[v.idx];
  markStorySeen(s.id);
  const u = group.user;
  const isMine = s.userId === state.user.id;
  v.elapsed = 0; v.video = null; v.holds = new Set(); v.paused = false;

  // Картинка/видео вписаны целиком в исходных пропорциях, фон — размытая копия
  const media = s.mediaType === 'video'
    ? `<video class="story-fs-bg" src="${s.mediaUrl}" muted loop autoplay playsinline></video><video class="story-fs-media" src="${s.mediaUrl}" autoplay playsinline></video>`
    : `<img class="story-fs-bg" src="${s.mediaUrl}" draggable="false" alt=""><img class="story-fs-media" src="${s.mediaUrl}" draggable="false">`;
  const texts = (s.texts || []).map((t) => `<div class="story-text-item static" style="${storyTextStyle(t)}">${escapeHtml(t.text)}</div>`).join('');
  const bars = stories.map((_, i) => `<div class="story-bar"><i style="width:${i < v.idx ? 100 : 0}%"></i></div>`).join('');
  const avatar = u.avatar ? `style="${avatarStyle(u)}"` : '';
  const heart = s.myReaction || '🤍';

  const bottom = isMine
    ? `<div class="story-own-bar"><button type="button" class="story-own-reactions" id="storyOwnReactionsBtn">${storyReactionSummary(s)}</button></div>`
    : `<div class="story-reply-bar">
         <input type="text" class="story-reply-input" id="storyReplyInput" placeholder="Ответить ${escapeHtml(u.displayName || '')}…" maxlength="1000" autocomplete="off">
         <button type="button" class="story-send-btn hidden" id="storySendBtn" title="Отправить">➤</button>
         <button type="button" class="story-heart-btn${s.myReaction ? ' active' : ''}" id="storyHeartBtn" title="Нажмите — сердечко, удерживайте — все реакции">${heart}</button>
       </div>`;

  $('#storyViewer').innerHTML = `
    <div class="story-fs-frame">
      ${media}
      <div class="story-fs-overlays">${texts}</div>
      <div class="story-fs-shade-top"></div><div class="story-fs-shade-bottom"></div>
      <div class="story-zone story-zone-prev"></div><div class="story-zone story-zone-next"></div>
      <div class="story-fs-top">
        <div class="story-bars">${bars}</div>
        <div class="story-fs-head">
          <div class="story-fs-ava" ${avatar}>${u.avatar ? '' : escapeHtml(initials(u.displayName || '?'))}</div>
          <div class="story-fs-who"><b>${escapeHtml(isMine ? 'Ваша история' : (u.displayName || ''))}</b><span>${storyAgo(s.createdAt)}</span></div>
          ${isMine ? '<button type="button" class="story-fs-btn" id="storyDeleteBtn" title="Удалить историю">🗑</button>' : ''}
          <button type="button" class="story-fs-btn" id="storyCloseBtn" title="Закрыть">✕</button>
        </div>
      </div>
      ${s.caption ? `<div class="story-fs-caption">${escapeHtml(s.caption)}</div>` : ''}
      ${s.link ? `<a class="story-link-chip story-link-chip-view" href="${escapeHtml(s.link.url)}" target="_blank" rel="noopener noreferrer nofollow"><span class="story-link-chip-ico">🔗</span><span>${escapeHtml(storyLinkLabel(s.link))}</span></a>` : ''}
      ${bottom}
      <div class="story-react-menu hidden" id="storyReactMenu"></div>
      <div class="story-own-panel hidden" id="storyOwnPanel"></div>
    </div>`;

  const frame = $('#storyViewer .story-fs-frame');
  v.frame = frame;
  const fills = frame.querySelectorAll('.story-bar i');

  // прогресс: у фото — таймер 5 с, у видео — по воспроизведению
  const vid = frame.querySelector('video.story-fs-media');
  if (vid) {
    v.video = vid;
    vid.addEventListener('ended', () => { if (storyV === v) storyStep(1); });
    // размытая копия видео на фоне идёт синхронно с основным
    const bgv = frame.querySelector('video.story-fs-bg');
    if (bgv) {
      vid.addEventListener('play', () => bgv.play().catch(() => {}));
      vid.addEventListener('pause', () => { try { bgv.pause(); } catch (e) {} });
      vid.addEventListener('timeupdate', () => { if (Math.abs(bgv.currentTime - vid.currentTime) > 0.3) { try { bgv.currentTime = vid.currentTime; } catch (e) {} } });
    }
  }
  v.last = performance.now();
  const tick = (now) => {
    if (storyV !== v) return;
    const dt = now - v.last; v.last = now;
    let p;
    if (vid) p = vid.duration > 0 ? vid.currentTime / vid.duration : 0;
    else { if (!v.paused) v.elapsed += dt; p = v.elapsed / STORY_IMAGE_MS; }
    fills[v.idx].style.width = Math.min(100, p * 100) + '%';
    if (!vid && p >= 1) { storyStep(1); return; }
    v.raf = requestAnimationFrame(tick);
  };
  v.raf = requestAnimationFrame(tick);

  bindStorySlide(frame, s, u, isMine);
}

function storyReactionSummary(s) {
  const r = s.reactions || {};
  const list = Object.values(r);
  if (!list.length) return '♡ Пока нет реакций';
  const uniq = [...new Set(list)].slice(0, 4).join('');
  return `${uniq} ${list.length}`;
}

function bindStorySlide(frame, s, u, isMine) {
  const v = storyV;
  $('#storyCloseBtn').addEventListener('click', () => closeStoryViewer());

  // Тап по левой/правой зоне — назад/вперёд, удержание — пауза, свайп вниз — закрыть.
  frame.querySelectorAll('.story-zone').forEach((zone) => {
    let st = null;
    zone.addEventListener('pointerdown', (e) => {
      st = { x: e.clientX, y: e.clientY, t: Date.now(), held: false };
      zone.setPointerCapture(e.pointerId);
      st.timer = setTimeout(() => { if (st) { st.held = true; storyHold('press', true); frame.classList.add('hold-ui'); } }, 220);
    });
    zone.addEventListener('pointermove', (e) => {
      if (!st) return;
      if (e.clientY - st.y > 110 && Math.abs(e.clientX - st.x) < 90) { clearTimeout(st.timer); st = null; storyHold('press', false); closeStoryViewer(); }
    });
    const end = (e, cancelled) => {
      if (!st) return;
      clearTimeout(st.timer);
      const wasHeld = st.held;
      const moved = Math.hypot(e.clientX - st.x, e.clientY - st.y) > 12;
      st = null;
      if (wasHeld) { storyHold('press', false); frame.classList.remove('hold-ui'); return; }
      if (cancelled || moved) return;
      // тап по пустому месту сначала закрывает открытые меню
      if (!$('#storyReactMenu').classList.contains('hidden') || !$('#storyOwnPanel').classList.contains('hidden')) {
        hideStoryMenus(); return;
      }
      if (document.activeElement && document.activeElement.id === 'storyReplyInput') { document.activeElement.blur(); return; }
      storyStep(zone.classList.contains('story-zone-prev') ? -1 : 1);
    };
    zone.addEventListener('pointerup', (e) => end(e, false));
    zone.addEventListener('pointercancel', (e) => end(e, true));
    zone.addEventListener('contextmenu', (e) => e.preventDefault());
  });

  const del = $('#storyDeleteBtn');
  if (del) del.addEventListener('click', async () => {
    storyHold('confirm', true);
    const ok = confirm('Удалить эту историю?');
    storyHold('confirm', false);
    if (!ok) return;
    try {
      await api(`/api/stories/${s.id}`, { method: 'DELETE' });
      const g = state.storyGroups[v.gi];
      g.stories.splice(v.idx, 1);
      loadStories();
      if (!g.stories.length) { closeStoryViewer(); return; }
      renderStorySlide();
    } catch (err) { alert(err.message); }
  });

  if (isMine) {
    $('#storyOwnReactionsBtn').addEventListener('click', () => openStoryOwnPanel(s));
    return;
  }

  // ----- ответ в личный чат -----
  const input = $('#storyReplyInput');
  const sendBtn = $('#storySendBtn');
  const heartBtn = $('#storyHeartBtn');
  const syncReplyUI = () => {
    const has = !!input.value.trim();
    sendBtn.classList.toggle('hidden', !has);
    heartBtn.classList.toggle('hidden', has);
  };
  input.addEventListener('focus', () => { storyHold('typing', true); hideStoryMenus(); });
  input.addEventListener('blur', () => storyHold('typing', false));
  input.addEventListener('input', syncReplyUI);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSend(); } });
  sendBtn.addEventListener('pointerdown', (e) => e.preventDefault()); // не терять фокус до отправки
  sendBtn.addEventListener('click', doSend);
  let sending = false;
  async function doSend() {
    const text = input.value.trim();
    if (!text || sending) return;
    sending = true;
    try {
      await sendStoryReply(s, text);
      input.value = '';
      syncReplyUI();
      input.blur();
      showToast('Ответ отправлен');
    } catch (err) {
      showToast(err.message || 'Не удалось отправить');
    } finally { sending = false; }
  }

  // ----- реакции: тап по сердечку — ❤️, удержание — меню всех реакций -----
  const menu = $('#storyReactMenu');
  menu.innerHTML = REACTIONS.map((e) => `<button type="button" data-emoji="${e}">${e}</button>`).join('');
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-emoji]');
    if (!b) return;
    hideStoryMenus();
    reactToStory(s, b.dataset.emoji, heartBtn);
  });
  let hold = null;
  heartBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    hold = { long: false };
    storyHold('heart', true);
    hold.timer = setTimeout(() => {
      hold.long = true;
      if (navigator.vibrate) { try { navigator.vibrate(15); } catch (_) {} }
      menu.classList.remove('hidden');
      heartBtn.classList.add('pressing');
      storyHold('menu', true);
    }, 380);
  });
  const endHold = (cancel) => {
    if (!hold) return;
    clearTimeout(hold.timer);
    const wasLong = hold.long; hold = null;
    heartBtn.classList.remove('pressing');
    storyHold('heart', false);
    if (wasLong || cancel) return;
    reactToStory(s, s.myReaction || '❤️', heartBtn);
  };
  heartBtn.addEventListener('pointerup', () => endHold(false));
  heartBtn.addEventListener('pointerleave', () => { if (hold && !hold.long) endHold(true); });
  heartBtn.addEventListener('pointercancel', () => endHold(true));
  heartBtn.addEventListener('contextmenu', (e) => e.preventDefault());
}

function hideStoryMenus() {
  const a = $('#storyReactMenu'); const b = $('#storyOwnPanel');
  if (a) a.classList.add('hidden');
  if (b) b.classList.add('hidden');
  storyHold('menu', false);
  storyHold('panel', false);
}

// Тот же эмодзи ещё раз — снимает реакцию (так же работает на сервере).
async function reactToStory(s, emoji, anchor) {
  const prev = s.myReaction || null;
  const next = prev === emoji ? null : emoji;
  s.myReaction = next; // оптимистично
  const btn = $('#storyHeartBtn');
  if (btn) { btn.textContent = next || '🤍'; btn.classList.toggle('active', !!next); }
  if (next) playReactionBurst(anchor || btn, next);
  try {
    const r = await api(`/api/stories/${s.id}/react`, { method: 'POST', body: { emoji } });
    s.myReaction = r.myReaction;
  } catch (err) {
    s.myReaction = prev;
    if (btn) { btn.textContent = prev || '🤍'; btn.classList.toggle('active', !!prev); }
    showToast(err.message || 'Не удалось поставить реакцию');
  }
}

async function sendStoryReply(s, text) {
  if (!state.ws || state.ws.readyState !== 1) throw new Error('Нет соединения с сервером');
  const { conversation } = await api('/api/conversations', { method: 'POST', body: { type: 'dm', userId: s.userId } });
  if (!state.conversations.some((c) => c.id === conversation.id)) await loadConversations();
  state.ws.send(JSON.stringify({
    type: 'message', conversationId: conversation.id, msgType: 'text', content: text,
    mediaUrl: null, meta: { storyReply: { storyId: s.id } }, replyToId: null,
  }));
}

// Автор видит, кто и чем отреагировал на его историю.
async function openStoryOwnPanel(s) {
  const panel = $('#storyOwnPanel');
  const entries = Object.entries(s.reactions || {});
  storyHold('panel', true);
  panel.classList.remove('hidden');
  if (!entries.length) { panel.innerHTML = '<div class="story-own-empty">Пока никто не отреагировал</div>'; return; }
  await Promise.all(entries.map(([uid]) => ensureUserCached(uid)));
  if (panel.classList.contains('hidden')) return;
  panel.innerHTML = '<div class="story-own-title">Реакции</div>' + entries.map(([uid, emoji]) => {
    const u = state.usersById[uid] || { displayName: 'Пользователь' };
    return `<div class="story-own-row"><div class="story-fs-ava sm" ${u.avatar ? `style="${avatarStyle(u)}"` : ''}>${u.avatar ? '' : escapeHtml(initials(u.displayName || '?'))}</div><span class="grow">${escapeHtml(u.displayName || '')}</span><span class="story-own-emoji">${emoji}</span></div>`;
  }).join('');
}

document.addEventListener('keydown', (e) => {
  if (!storyV) return;
  if (e.key === 'Escape') closeStoryViewer();
  else if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  else if (e.key === 'ArrowRight') storyStep(1);
  else if (e.key === 'ArrowLeft') storyStep(-1);
});
document.addEventListener('visibilitychange', () => storyHold('hidden', document.hidden));

/* ---- Создание: отдельная страница (выбор → редактор → шторка «Публикация») ---- */

// Фоны для текстовых историй: угол и остановки градиента (одно описание и для CSS, и для canvas).
const STORY_BGS = [
  { a: 200, c: ['#8f00f0', '#6a4dff', '#3d96ff'] },
  { a: 160, c: ['#b4ffe9', '#6fe0c6'] },
  { a: 160, c: ['#ff8a4c', '#ff5a36'] },
  { a: 160, c: ['#ff86bd', '#ff9fb8'] },
  { a: 160, c: ['#5a5a5a', '#2a2a2a'] },
  { a: 160, c: ['#a9d2f5', '#7fb5ea'] },
  { a: 160, c: ['#7acdd6', '#4aa3c4'] },
  { a: 160, c: ['#ffb8cc', '#ffd9b0'] },
];
const storyBgCss = (g) => `linear-gradient(${g.a}deg, ${g.c.join(', ')})`;

const STORY_AUD_KEY = 'asteria.storyAudience';
function loadStoryAudience() {
  try { return localStorage.getItem(STORY_AUD_KEY) === 'contacts' ? 'contacts' : 'all'; } catch (e) { return 'all'; }
}
const storyDraft = {
  file: null, url: null, type: 'image', kind: 'media', bg: 0, texts: [], sel: -1, link: null, publishing: false,
  hours: 24, audience: loadStoryAudience(), draw: false, strokes: [], textColor: '#ffffff', brushColor: '#ffffff',
};
const storyRecent = []; // выбранные в этой сессии файлы — показываем плитками, как галерею

function resetStoryDraft() {
  if (storyDraft.url) { try { URL.revokeObjectURL(storyDraft.url); } catch (e) {} }
  Object.assign(storyDraft, {
    file: null, url: null, type: 'image', kind: 'media', bg: 0, texts: [], sel: -1, link: null, publishing: false,
    hours: 24, audience: loadStoryAudience(), draw: false, strokes: [], textColor: '#ffffff', brushColor: '#ffffff',
  });
  $('#storyFileInput').value = '';
  $('#storyCameraInput').value = '';
  $('#storyPreviewWrap').innerHTML = '';
  $('#storyCaption').value = '';
  $('#storyCreateError').textContent = '';
  $('#storyPublishError').textContent = '';
  $('#storyTextPanel').classList.add('hidden');
  $('#storyLinkPanel').classList.add('hidden');
  closeStoryPublishSheet();
  showStoryStep('picker');
  renderStoryRecents();
  renderStoryTtl();
  renderStoryAudience();
  const btn = $('#publishStoryBtn');
  btn.disabled = false; btn.textContent = 'Опубликовать';
  $('#storyNextBtn').disabled = true;
  renderStoryDraft();
}

function showStoryStep(step) {
  $('#storyPicker').classList.toggle('hidden', step !== 'picker');
  $('#storyCompose').classList.toggle('hidden', step !== 'editor');
}

// Плитки недавних файлов рядом с «Камерой», «Текстовой историей» и «Галереей»
function renderStoryRecents() {
  const grid = $('#storyGrid');
  grid.querySelectorAll('.sc-tile-thumb').forEach((el) => el.remove());
  storyRecent.forEach((r, i) => {
    const t = document.createElement('button');
    t.type = 'button'; t.className = 'sc-tile sc-tile-thumb'; t.dataset.i = i;
    t.innerHTML = r.type === 'video'
      ? `<video src="${r.thumb}#t=0.1" muted playsinline preload="metadata"></video><span class="sc-tile-badge">видео</span>`
      : `<img src="${r.thumb}" alt="" draggable="false">`;
    grid.appendChild(t);
  });
}
$('#storyGrid').addEventListener('click', (e) => {
  const t = e.target.closest('.sc-tile-thumb');
  if (!t) return;
  const r = storyRecent[+t.dataset.i];
  if (r) setStoryFile(r.file, true);
});

// Срок показа: 6 / 12 / 24 / 48 ч.
function renderStoryTtl() {
  $all('#storyTtlChips .story-ttl-chip').forEach((b) => {
    const h = +b.dataset.h;
    b.classList.toggle('active', h === storyDraft.hours);
  });
  $('#storyTtlLabel').textContent = storyDraft.hours + ' ч';
}
$('#storyTtlBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#storyTtlChips').classList.toggle('hidden'); });
$('#storyTtlChips').addEventListener('click', (e) => {
  const b = e.target.closest('.story-ttl-chip');
  if (!b) return;
  const h = +b.dataset.h;
  storyDraft.hours = h;
  renderStoryTtl();
  $('#storyTtlChips').classList.add('hidden');
});
$('.sc-pub-card').addEventListener('click', (e) => {
  if (!e.target.closest('#storyTtlChips') && !e.target.closest('#storyTtlBtn')) $('#storyTtlChips').classList.add('hidden');
});

function renderStoryAudience() {
  $all('#storyAudience .sc-radio').forEach((b) => b.classList.toggle('active', b.dataset.aud === storyDraft.audience));
}
$('#storyAudience').addEventListener('click', (e) => {
  const b = e.target.closest('.sc-radio');
  if (!b) return;
  storyDraft.audience = b.dataset.aud === 'contacts' ? 'contacts' : 'all';
  try { localStorage.setItem(STORY_AUD_KEY, storyDraft.audience); } catch (err) {}
  renderStoryAudience();
});

function openStoryPublishSheet() {
  renderStoryTtl(); renderStoryAudience();
  $('#storyPublishError').textContent = '';
  $('#storyTtlChips').classList.add('hidden');
  $('#storyPublishSheet').classList.remove('hidden');
}
function closeStoryPublishSheet() {
  if (storyDraft.publishing) return;
  $('#storyPublishSheet').classList.add('hidden');
}
$('#storyPubBackdrop').addEventListener('click', closeStoryPublishSheet);

function openCreateStoryModal() { // имя сохранено для старых вызовов
  resetStoryDraft();
  switchSection('storyCreate');
}

function closeCreateStoryPage() {
  switchSection(state.subpageReturnSection && state.subpageReturnSection !== 'storyCreate' ? state.subpageReturnSection : 'chats');
  resetStoryDraft();
}

/* ---- Сцена: фон/медиа ---- */

// Картинка вписывается целиком в исходных пропорциях, а фон — она же, но размытая.
function renderStoryMedia() {
  const wrap = $('#storyPreviewWrap');
  if (storyDraft.kind === 'text') {
    wrap.innerHTML = `<div class="sm-grad" style="background:${storyBgCss(STORY_BGS[storyDraft.bg])}"></div>`;
  } else if (storyDraft.type === 'video') {
    wrap.innerHTML = `<video class="sm-bg" src="${storyDraft.url}" autoplay muted loop playsinline></video><video class="sm-main" src="${storyDraft.url}" autoplay muted loop playsinline></video>`;
  } else {
    wrap.innerHTML = `<img class="sm-bg" src="${storyDraft.url}" draggable="false" alt=""><img class="sm-main" src="${storyDraft.url}" draggable="false" alt="">`;
  }
}

function renderStoryDraft() {
  const wrap = $('#storyOverlays');
  wrap.innerHTML = '';
  storyDraft.texts.forEach((t, i) => {
    const el = document.createElement('div');
    el.className = 'story-text-item' + (i === storyDraft.sel ? ' selected' : '');
    el.dataset.i = i;
    el.style.cssText = storyTextStyle(t);
    el.textContent = t.text || 'Текст';
    wrap.appendChild(el);
  });
  const chip = $('#storyLinkChip');
  if (storyDraft.link) {
    chip.classList.remove('hidden');
    $('#storyLinkChipText').textContent = storyLinkLabel(storyDraft.link);
  } else chip.classList.add('hidden');
  $('#storyLinkChip').removeAttribute('href');
  const sw = $('#storySwatches');
  if (!sw.children.length) {
    sw.innerHTML = STORY_TEXT_COLORS.map((c) => `<button type="button" class="story-swatch" data-color="${c}" style="background:${c}"></button>`).join('');
  }
  const cur = storyDraft.texts[storyDraft.sel];
  sw.querySelectorAll('.story-swatch').forEach((b) => b.classList.toggle('active', !!cur && cur.color === b.dataset.color));
  $('#storyTextBgBtn').classList.toggle('active', !!(cur && cur.bg));
  syncStoryEditor();
}

// Подсказка «Добавить текст», нижний ряд цветов, кнопки режимов
function syncStoryEditor() {
  const textMode = storyDraft.kind === 'text';
  const panelOpen = !$('#storyTextPanel').classList.contains('hidden') || !$('#storyLinkPanel').classList.contains('hidden');
  $('#storyTextHint').classList.toggle('hidden', !(textMode && !storyDraft.texts.length && !panelOpen && !storyDraft.draw));
  const row = $('#storyColors');
  const showRow = !panelOpen && (storyDraft.draw || textMode);
  row.classList.toggle('hidden', !showRow);
  if (showRow) {
    if (storyDraft.draw) {
      row.innerHTML = STORY_TEXT_COLORS.map((c) => `<button type="button" class="sc-color${storyDraft.brushColor === c ? ' active' : ''}" data-color="${c}" style="background:${c}"></button>`).join('');
    } else {
      row.innerHTML = STORY_BGS.map((g, i) => `<button type="button" class="sc-color${storyDraft.bg === i ? ' active' : ''}" data-bg="${i}" style="background:${storyBgCss(g)}"></button>`).join('');
    }
  }
  $('#storyDrawBtn').classList.toggle('active', storyDraft.draw);
  $('#storyUndoBtn').classList.toggle('hidden', !(storyDraft.draw && storyDraft.strokes.length));
  $('#storyStage').classList.toggle('drawing', storyDraft.draw);
  requestAnimationFrame(syncStorySheetPad);
}
$('#storyColors').addEventListener('click', (e) => {
  const b = e.target.closest('.sc-color');
  if (!b) return;
  if (b.dataset.bg !== undefined) { storyDraft.bg = +b.dataset.bg; renderStoryMedia(); }
  else storyDraft.brushColor = b.dataset.color;
  syncStoryEditor();
});


// Когда открыта нижняя панель текста/ссылки, кадр целиком помещается над ней (а не прячется под
// панелью и клавиатурой), и браузер не «уносит» редактор прокруткой при фокусе в поле.
function syncStorySheetPad() {
  const ed = document.querySelector('.sc-editor'); if (!ed) return;
  const panel = ['#storyTextPanel', '#storyLinkPanel'].map((s) => $(s)).find((p) => p && !p.classList.contains('hidden'));
  if (panel) { ed.style.setProperty('--sheet-h', panel.offsetHeight + 'px'); ed.classList.add('editing-text'); }
  else { ed.classList.remove('editing-text'); ed.style.removeProperty('--sheet-h'); }
}
function lockStoryEditorScroll() {
  let n = document.querySelector('.sc-editor');
  while (n && n !== document.documentElement) { if (n.scrollTop) n.scrollTop = 0; if (n.scrollLeft) n.scrollLeft = 0; n = n.parentElement; }
  try { window.scrollTo(0, 0); } catch (e) {}
  syncStorySheetPad();
}
if (window.visualViewport) window.visualViewport.addEventListener('resize', () => { if (document.querySelector('.sc-editor.editing-text')) { lockStoryEditorScroll(); } });
document.addEventListener('scroll', (e) => { if (document.querySelector('.sc-editor.editing-text') && e.target !== document && e.target.closest && e.target.closest('.sc-editor')) lockStoryEditorScroll(); }, true);

function selectStoryText(i, focus) {
  storyDraft.sel = i;
  const panel = $('#storyTextPanel');
  if (i < 0) { panel.classList.add('hidden'); renderStoryDraft(); return; }
  setStoryDraw(false);
  $('#storyLinkPanel').classList.add('hidden');
  panel.classList.remove('hidden');
  $('#storyTextInput').value = storyDraft.texts[i].text;
  renderStoryDraft();
  if (focus) setTimeout(() => { try { $('#storyTextInput').focus({ preventScroll: true }); } catch (e) { $('#storyTextInput').focus(); } lockStoryEditorScroll(); }, 0);
}

function pruneEmptyStoryTexts() {
  const keep = storyDraft.texts.filter((t) => t.text.trim());
  if (keep.length !== storyDraft.texts.length) { storyDraft.texts = keep; storyDraft.sel = -1; $('#storyTextPanel').classList.add('hidden'); renderStoryDraft(); }
}

/* ---- Выбор файла / текстовая история ---- */

function setStoryFile(file, fromRecent) {
  if (!file) return;
  if (storyDraft.url) { try { URL.revokeObjectURL(storyDraft.url); } catch (e) {} }
  storyDraft.file = file;
  storyDraft.url = URL.createObjectURL(file);
  storyDraft.type = file.type.startsWith('video') ? 'video' : 'image';
  storyDraft.kind = 'media';
  storyDraft.strokes = []; storyDraft.draw = false;
  if (!fromRecent && !storyRecent.some((r) => r.file === file)) {
    storyRecent.unshift({ file, thumb: URL.createObjectURL(file), type: storyDraft.type });
    while (storyRecent.length > 11) { const r = storyRecent.pop(); try { URL.revokeObjectURL(r.thumb); } catch (e) {} }
  }
  renderStoryMedia();
  showStoryStep('editor');
  $('#storyNextBtn').disabled = false;
  $('#storyCreateError').textContent = '';
  renderStoryDraft();
  resizeStoryDrawCanvas();
}

function startTextStory() {
  if (storyDraft.url) { try { URL.revokeObjectURL(storyDraft.url); } catch (e) {} }
  Object.assign(storyDraft, { file: null, url: null, type: 'image', kind: 'text', strokes: [], draw: false });
  renderStoryMedia();
  showStoryStep('editor');
  $('#storyNextBtn').disabled = false;
  renderStoryDraft();
  resizeStoryDrawCanvas();
}

$('#storyPickFileBtn').addEventListener('click', () => $('#storyFileInput').click());
$('#storyGalleryTitleBtn').addEventListener('click', () => $('#storyFileInput').click());
$('#storyCameraBtn').addEventListener('click', () => $('#storyCameraInput').click());
$('#storyTextStoryBtn').addEventListener('click', startTextStory);
$('#storyFileInput').addEventListener('change', () => setStoryFile($('#storyFileInput').files[0]));
$('#storyCameraInput').addEventListener('change', () => setStoryFile($('#storyCameraInput').files[0]));
$('#storyCreateBackBtn').addEventListener('click', closeCreateStoryPage);
$('#storyEditorBackBtn').addEventListener('click', () => {
  if (storyDraft.url) { try { URL.revokeObjectURL(storyDraft.url); } catch (e) {} }
  Object.assign(storyDraft, { file: null, url: null, kind: 'media', texts: [], sel: -1, link: null, strokes: [], draw: false });
  $('#storyPreviewWrap').innerHTML = '';
  $('#storyTextPanel').classList.add('hidden');
  $('#storyLinkPanel').classList.add('hidden');
  $('#storyNextBtn').disabled = true;
  showStoryStep('picker');
  renderStoryDraft();
});

/* ---- Текст ---- */

function addStoryText() {
  pruneEmptyStoryTexts();
  if (storyDraft.texts.length >= 8) { showToast('Не больше 8 надписей'); return; }
  storyDraft.texts.push({ text: '', x: 0.5, y: 0.45, size: 32, color: storyDraft.textColor, bg: false });
  selectStoryText(storyDraft.texts.length - 1, true);
}
$('#storyAddTextBtn').addEventListener('click', addStoryText);
$('#storyTextHint').addEventListener('click', addStoryText);
$('#storyTextInput').addEventListener('input', (e) => {
  const t = storyDraft.texts[storyDraft.sel];
  if (!t) return;
  t.text = e.target.value;
  const el = $(`#storyOverlays .story-text-item[data-i="${storyDraft.sel}"]`);
  if (el) el.textContent = t.text || 'Текст';
});
function finishStoryText() { e_blur(); selectStoryText(-1); pruneEmptyStoryTexts(); }
function e_blur() { try { document.activeElement && document.activeElement.blur(); } catch (e) {} }
$('#storyTextInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finishStoryText(); } });
$('#storyTextDoneBtn').addEventListener('click', finishStoryText);
$('#storySwatches').addEventListener('click', (e) => {
  const b = e.target.closest('.story-swatch'); const t = storyDraft.texts[storyDraft.sel];
  if (!b || !t) return;
  t.color = b.dataset.color; storyDraft.textColor = t.color; renderStoryDraft();
});
$('#storyTextBgBtn').addEventListener('click', () => { const t = storyDraft.texts[storyDraft.sel]; if (t) { t.bg = !t.bg; renderStoryDraft(); } });
$('#storyTextBiggerBtn').addEventListener('click', () => { const t = storyDraft.texts[storyDraft.sel]; if (t) { t.size = Math.min(64, t.size + 4); renderStoryDraft(); } });
$('#storyTextSmallerBtn').addEventListener('click', () => { const t = storyDraft.texts[storyDraft.sel]; if (t) { t.size = Math.max(12, t.size - 4); renderStoryDraft(); } });
$('#storyTextDeleteBtn').addEventListener('click', () => {
  if (storyDraft.sel < 0) return;
  storyDraft.texts.splice(storyDraft.sel, 1);
  selectStoryText(-1);
});

// Перетаскивание текста по кадру (координаты — доли от размера кадра) + щипок двумя пальцами
// для размера. Размер блока при перетаскивании не меняется: он зависит только от самого текста
// и выбранного пользователем размера шрифта.
(function initStoryTextDrag() {
  const overlays = $('#storyOverlays');
  const stage = $('#storyStage');
  let drag = null, pinch = null;
  const pts = new Map();
  const itemEl = (i) => overlays.querySelector(`.story-text-item[data-i="${i}"]`);
  const clampPos = (t, el, rect) => {
    const hw = el ? Math.min(0.5, el.offsetWidth / rect.width / 2) : 0.04;
    const hh = el ? Math.min(0.5, el.offsetHeight / rect.height / 2) : 0.04;
    t.x = Math.min(1 - hw, Math.max(hw, t.x));
    t.y = Math.min(1 - hh, Math.max(hh, t.y));
  };
  stage.addEventListener('pointerdown', (e) => {
    if (storyDraft.draw) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // второй палец на выбранном тексте — масштабирование
    if (pts.size === 2 && storyDraft.sel >= 0 && storyDraft.texts[storyDraft.sel]) {
      const [p1, p2] = Array.from(pts.values());
      pinch = { i: storyDraft.sel, d0: Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1, s0: storyDraft.texts[storyDraft.sel].size || 28 };
      if (drag) drag.moved = true;
      e.preventDefault(); return;
    }
    const item = e.target.closest('.story-text-item');
    if (!item) {
      if (storyDraft.sel >= 0 && !e.target.closest('.story-link-chip') && !e.target.closest('.sc-stage-btn')) { selectStoryText(-1); pruneEmptyStoryTexts(); }
      return;
    }
    const i = +item.dataset.i;
    const rect = overlays.getBoundingClientRect();
    const t = storyDraft.texts[i];
    drag = { i, rect, dx: e.clientX - (rect.left + t.x * rect.width), dy: e.clientY - (rect.top + t.y * rect.height), x0: e.clientX, y0: e.clientY, moved: false, wasSel: storyDraft.sel === i };
    if (storyDraft.sel !== i) selectStoryText(i, false);
    try { stage.setPointerCapture(e.pointerId); } catch (er) {}
    e.preventDefault();
  });
  stage.addEventListener('pointermove', (e) => {
    if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size >= 2) {
      const [p1, p2] = Array.from(pts.values());
      const t = storyDraft.texts[pinch.i]; if (!t) return;
      t.size = Math.round(Math.min(96, Math.max(12, pinch.s0 * (Math.hypot(p1.x - p2.x, p1.y - p2.y) / pinch.d0))));
      const el = itemEl(pinch.i);
      if (el) { el.style.fontSize = ((t.size / 360) * 100).toFixed(3) + 'cqw'; clampPos(t, el, overlays.getBoundingClientRect()); el.style.left = (t.x * 100) + '%'; el.style.top = (t.y * 100) + '%'; }
      return;
    }
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return;
    drag.moved = true;
    const t = storyDraft.texts[drag.i];
    t.x = (e.clientX - drag.dx - drag.rect.left) / drag.rect.width;
    t.y = (e.clientY - drag.dy - drag.rect.top) / drag.rect.height;
    const el = itemEl(drag.i);
    clampPos(t, el, drag.rect);
    if (el) { el.style.left = (t.x * 100) + '%'; el.style.top = (t.y * 100) + '%'; }
  });
  const end = (e) => {
    pts.delete(e.pointerId);
    if (pinch) { if (pts.size < 2) pinch = null; drag = null; return; }
    if (!drag) return;
    const d = drag; drag = null;
    if (!d.moved && d.wasSel) { try { $('#storyTextInput').focus({ preventScroll: true }); } catch (er) {} lockStoryEditorScroll(); } // повторный тап — править текст
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); drag = null; if (pts.size < 2) pinch = null; });
})();

/* ---- Рисование (кисть) ---- */

const STORY_BRUSH_W = 0.012; // толщина линии — доля ширины кадра

function resizeStoryDrawCanvas() {
  const c = $('#storyDrawCanvas');
  const r = c.getBoundingClientRect();
  if (!r.width) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
  redrawStoryStrokes();
}
function paintStrokes(ctx, W, H, strokes) {
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  strokes.forEach((st) => {
    ctx.strokeStyle = st.color; ctx.fillStyle = st.color; ctx.lineWidth = STORY_BRUSH_W * W;
    if (st.pts.length === 1) {
      ctx.beginPath(); ctx.arc(st.pts[0][0] * W, st.pts[0][1] * H, STORY_BRUSH_W * W / 2, 0, Math.PI * 2); ctx.fill(); return;
    }
    ctx.beginPath();
    st.pts.forEach((p, i) => (i ? ctx.lineTo(p[0] * W, p[1] * H) : ctx.moveTo(p[0] * W, p[1] * H)));
    ctx.stroke();
  });
}
function redrawStoryStrokes() {
  const c = $('#storyDrawCanvas');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  paintStrokes(ctx, c.width, c.height, storyDraft.strokes);
}
function setStoryDraw(on) {
  if (on && storyDraft.type === 'video' && storyDraft.kind === 'media') { showToast('Рисовать можно на фото и на текстовой истории'); return; }
  if (on) {
    selectStoryText(-1); pruneEmptyStoryTexts();
    $('#storyLinkPanel').classList.add('hidden');
  }
  storyDraft.draw = !!on;
  syncStoryEditor();
}
$('#storyDrawBtn').addEventListener('click', () => setStoryDraw(!storyDraft.draw));
$('#storyUndoBtn').addEventListener('click', () => { storyDraft.strokes.pop(); redrawStoryStrokes(); syncStoryEditor(); });
(function initStoryDraw() {
  const c = $('#storyDrawCanvas');
  let cur = null;
  const pt = (e) => { const r = c.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]; };
  c.addEventListener('pointerdown', (e) => {
    if (!storyDraft.draw) return;
    cur = { color: storyDraft.brushColor, pts: [pt(e)] };
    storyDraft.strokes.push(cur);
    c.setPointerCapture(e.pointerId); e.preventDefault();
    redrawStoryStrokes();
  });
  c.addEventListener('pointermove', (e) => {
    if (!cur) return;
    cur.pts.push(pt(e));
    redrawStoryStrokes();
  });
  const end = () => { if (cur) { cur = null; syncStoryEditor(); } };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
  if (window.ResizeObserver) new ResizeObserver(() => resizeStoryDrawCanvas()).observe($('#storyStage'));
  window.addEventListener('resize', resizeStoryDrawCanvas);
})();

/* ---- Ссылка ---- */

$('#storyAddLinkBtn').addEventListener('click', () => {
  selectStoryText(-1); pruneEmptyStoryTexts(); setStoryDraw(false);
  const panel = $('#storyLinkPanel');
  const open = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !open);
  if (open) {
    $('#storyLinkUrl').value = storyDraft.link ? storyDraft.link.url : '';
    $('#storyLinkLabel').value = storyDraft.link ? (storyDraft.link.label || '') : '';
    setTimeout(() => $('#storyLinkUrl').focus(), 0);
  }
  syncStoryEditor();
});
$('#storyLinkSaveBtn').addEventListener('click', () => {
  let url = $('#storyLinkUrl').value.trim();
  if (!url) { storyDraft.link = null; $('#storyLinkPanel').classList.add('hidden'); renderStoryDraft(); return; }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
  try {
    const p = new URL(url);
    if (p.protocol !== 'http:' && p.protocol !== 'https:') throw new Error('proto');
    storyDraft.link = { url: p.toString(), label: $('#storyLinkLabel').value.trim() };
  } catch (e) { showToast('Введите корректную ссылку'); return; }
  $('#storyLinkPanel').classList.add('hidden');
  renderStoryDraft();
});
$('#storyLinkRemoveBtn').addEventListener('click', () => {
  storyDraft.link = null;
  $('#storyLinkPanel').classList.add('hidden');
  renderStoryDraft();
});

/* ---- Сборка кадра 1080×1920 (для рисунка поверх фото, текстовой истории и «Сохранить») ---- */

function loadStoryImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Не удалось прочитать изображение'));
    img.src = url;
  });
}
function storyGradientFill(ctx, W, H, g) {
  const rad = (g.a - 90) * Math.PI / 180; // как CSS: 180° — сверху вниз
  const dx = Math.cos(rad), dy = Math.sin(rad);
  const len = Math.abs(W * dx) + Math.abs(H * dy);
  const cx = W / 2, cy = H / 2;
  const grad = ctx.createLinearGradient(cx - dx * len / 2, cy - dy * len / 2, cx + dx * len / 2, cy + dy * len / 2);
  g.c.forEach((col, i) => grad.addColorStop(g.c.length === 1 ? 0 : i / (g.c.length - 1), col));
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
}
function storyDrawText(ctx, W, H, t) {
  const fs = (t.size || 28) * W / 360;
  ctx.font = `800 ${fs}px -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  const maxW = W * 0.9 - fs * 0.6;
  const lines = [];
  String(t.text).split('\n').forEach((para) => {
    let line = '';
    para.split(/\s+/).forEach((w) => {
      const test = line ? line + ' ' + w : w;
      if (line && ctx.measureText(test).width > maxW) { lines.push(line); line = w; } else line = test;
    });
    lines.push(line);
  });
  const lh = fs * 1.15;
  const bw = Math.min(W * 0.9, Math.max(...lines.map((l) => ctx.measureText(l).width)) + fs * 0.6);
  const bh = lines.length * lh + fs * 0.24;
  const cx = t.x * W, cy = t.y * H;
  const n = parseInt((t.color || '#ffffff').slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  if (t.bg) {
    ctx.fillStyle = t.color;
    const r = fs * 0.28, x = cx - bw / 2, y = cy - bh / 2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, bw, bh, r); else ctx.rect(x, y, bw, bh);
    ctx.fill();
    ctx.fillStyle = lum > 0.6 ? '#000' : '#fff';
    ctx.shadowColor = 'transparent';
  } else {
    ctx.fillStyle = t.color; ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = fs * 0.15; ctx.shadowOffsetY = fs * 0.04;
  }
  lines.forEach((l, i) => ctx.fillText(l, cx, cy - bh / 2 + fs * 0.12 + lh * (i + 0.5)));
  ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
}
async function composeStoryCanvas({ withTexts }) {
  const W = 1080, H = 1920;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  if (storyDraft.kind === 'text') {
    storyGradientFill(ctx, W, H, STORY_BGS[storyDraft.bg]);
  } else {
    const img = await loadStoryImage(storyDraft.url);
    const iw = img.naturalWidth, ih = img.naturalHeight;
    // фон: «cover» через крошечный холст и обратное растяжение — размытие без ctx.filter (его нет в Safari)
    const sm = document.createElement('canvas'); sm.width = 27; sm.height = 48;
    const sctx = sm.getContext('2d');
    const cs = Math.max(27 / iw, 48 / ih);
    sctx.drawImage(img, (27 - iw * cs) / 2, (48 - ih * cs) / 2, iw * cs, ih * cs);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sm, 0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,.15)'; ctx.fillRect(0, 0, W, H);
    const fit = Math.min(W / iw, H / ih);
    ctx.drawImage(img, (W - iw * fit) / 2, (H - ih * fit) / 2, iw * fit, ih * fit);
  }
  paintStrokes(ctx, W, H, storyDraft.strokes);
  if (withTexts) storyDraft.texts.filter((t) => t.text.trim()).forEach((t) => storyDrawText(ctx, W, H, t));
  return cv;
}
const canvasToBlob = (cv, type, q) => new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('Не удалось собрать картинку'))), type, q));

// «Сохранить»: кадр целиком (видео — исходный файл)
$('#storySaveBtn').addEventListener('click', async () => {
  const btn = $('#storySaveBtn');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    let blob, name, type = 'image';
    if (storyDraft.kind === 'media' && storyDraft.type === 'video') {
      blob = storyDraft.file; name = storyDraft.file.name || 'story.mp4'; type = 'video';
    } else {
      blob = await canvasToBlob(await composeStoryCanvas({ withTexts: true }), 'image/jpeg', 0.92);
      name = 'story-' + Date.now() + '.jpg';
    }
    const file = new File([blob], name, { type: blob.type || (type === 'video' ? 'video/mp4' : 'image/jpeg') });
    if (window.AsteriaNotify && typeof window.AsteriaNotify.downloadMedia === 'function') {
      // нативное приложение качает только по http(s)-адресу — отдаём файл серверу и забираем обратно
      const url = await uploadFile(file, 'story');
      await downloadMediaBatch([{ url, type, name }]);
      showToast('Загрузка начата');
    } else if (IS_MOBILE_BROWSER && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); } catch (e) { if (!e || e.name !== 'AbortError') throw e; }
    } else {
      const a = document.createElement('a');
      const u = URL.createObjectURL(file);
      a.href = u; a.download = name; a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 30000);
    }
  } catch (err) {
    showToast((err && err.message) || 'Не удалось сохранить');
  } finally { btn.disabled = false; }
});

/* ---- Далее → шторка «Публикация» → публикация ---- */

$('#storyNextBtn').addEventListener('click', () => {
  pruneEmptyStoryTexts();
  if (storyDraft.kind === 'text' && !storyDraft.texts.length && !storyDraft.strokes.length) { showToast('Добавьте текст или рисунок'); return; }
  if (storyDraft.kind === 'media' && !storyDraft.file) { showToast('Выберите фото или видео'); return; }
  e_blur();
  openStoryPublishSheet();
});

$('#publishStoryBtn').addEventListener('click', async () => {
  if (storyDraft.publishing) return;
  pruneEmptyStoryTexts();
  const btn = $('#publishStoryBtn');
  const err = $('#storyPublishError');
  storyDraft.publishing = true; btn.disabled = true; btn.textContent = 'Загрузка…'; err.textContent = '';
  try {
    let file = storyDraft.file, mediaType = storyDraft.type;
    // Текстовая история и фото с рисунком уходят одной готовой картинкой 9:16 (текст остаётся отдельными надписями)
    if (storyDraft.kind === 'text' || (storyDraft.strokes.length && mediaType === 'image')) {
      const blob = await canvasToBlob(await composeStoryCanvas({ withTexts: false }), 'image/jpeg', 0.9);
      file = new File([blob], 'story.jpg', { type: 'image/jpeg' });
      mediaType = 'image';
    }
    const url = await uploadFile(file, 'story');
    await api('/api/stories', { method: 'POST', body: {
      mediaUrl: url, mediaType, caption: $('#storyCaption').value.trim(),
      texts: storyDraft.texts, link: storyDraft.link, hours: storyDraft.hours, audience: storyDraft.audience,
    } });
    storyDraft.publishing = false;
    await loadStories();
    closeCreateStoryPage();
  } catch (e) {
    err.textContent = e.message || 'Не удалось опубликовать историю';
    storyDraft.publishing = false; btn.disabled = false; btn.textContent = 'Опубликовать';
  }
});

/* ---------------- ИСТОРИЯ ЗВОНКОВ (раздел «Звонки») ---------------- */

async function loadCallHistory() {
  try {
    const { calls } = await api('/api/calls');
    renderCallHistory(calls);
  } catch (err) {
    $('#callsList').innerHTML = '<div class="calls-empty">Не удалось загрузить историю звонков</div>';
  }
}

function formatDuration(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function renderCallHistory(calls) {
  const el = $('#callsList');
  el.innerHTML = '';
  if (!calls.length) {
    el.innerHTML = '<div class="calls-empty">Пока нет звонков — история появится здесь</div>';
    return;
  }
  calls.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'call-history-row';
    if (c.mode === '1:1') {
      const name = c.peer ? peerDisplayName(c.peer.id, c.peer) : 'Неизвестный';
      const dirIcon = c.direction === 'outgoing' ? '↗' : '↙';
      let icon = dirIcon, statusText = 'Звонок', statusClass = '';
      if (c.status === 'missed') { icon = '✕'; statusText = c.direction === 'outgoing' ? 'Не ответили' : 'Пропущенный'; statusClass = 'missed'; }
      else if (c.status === 'declined') { icon = '✕'; statusText = 'Отклонён'; statusClass = 'missed'; }
      else if (c.status === 'answered') { statusText = c.durationSec != null ? formatDuration(c.durationSec) : 'Разговор'; }
      const kindIcon = c.kind === 'video' ? '🎥' : '📞';
      row.innerHTML = `
        <div class="avatar" style="${c.peer ? avatarStyle(c.peer) : ''}">${c.peer && c.peer.avatar ? '' : initials(name)}</div>
        <div class="grow">
          <div class="name">${escapeHtml(name)} <span class="call-icon">${kindIcon}</span></div>
          <div class="sub ${statusClass}">${icon} ${escapeHtml(statusText)}</div>
        </div>
        <div class="time">${fmtTime(c.startedAt)}<div class="call-date">${escapeHtml(dateSeparatorLabel(c.startedAt))}</div></div>
        ${c.peer ? `<button class="redial-btn" data-redial="${c.peer.id}" data-kind="${c.kind}" title="Перезвонить">${kindIcon}</button>` : ''}
      `;
    } else {
      const durationText = c.durationSec != null ? formatDuration(c.durationSec) : (c.status === 'ongoing' ? 'Идёт сейчас' : '');
      row.innerHTML = `
        <div class="avatar">🎧</div>
        <div class="grow">
          <div class="name">${escapeHtml(c.channelName || 'Канал')} <span class="call-icon">👥</span></div>
          <div class="sub">Групповой звонок${durationText ? ' · ' + escapeHtml(durationText) : ''}</div>
        </div>
        <div class="time">${fmtTime(c.startedAt)}<div class="call-date">${escapeHtml(dateSeparatorLabel(c.startedAt))}</div></div>
      `;
    }
    el.appendChild(row);
  });
  el.querySelectorAll('[data-redial]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await redialUser(btn.dataset.redial, btn.dataset.kind);
    });
  });
}

async function redialUser(userId, kind) {
  const { conversation } = await api('/api/conversations', { method: 'POST', body: { type: 'dm', userId } });
  await loadConversations();
  switchSection('chats');
  await openConversation(conversation.id);
  startCall(kind || 'audio');
}

/* ---------------- CALLS (WebRTC) ---------------- */

// В локальной сети браузерам почти всегда хватало прямого соединения (или
// одного публичного STUN). В глобальной сети между двумя обычными интернет-
// подключениями почти всегда стоит NAT, и без TURN-релея звонок у части
// пользователей просто не будет соединяться. Поэтому конфигурация ICE теперь
// подтягивается с сервера (свой TURN + STUN, см. /api/turn-credentials) и
// периодически обновляется, а не зашита в один статический STUN-адрес.
let RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }; // резерв, пока не подтянули настоящий
let rtcConfigFetchedAt = 0;
async function ensureRtcConfig() {
  const fresh = Date.now() - rtcConfigFetchedAt < 3 * 60 * 60 * 1000; // креды живут 6ч на сервере, обновляем с запасом
  if (fresh) return RTC_CONFIG;
  try {
    const data = await api('/api/turn-credentials');
    if (data && Array.isArray(data.iceServers) && data.iceServers.length) {
      RTC_CONFIG = { iceServers: data.iceServers };
      rtcConfigFetchedAt = Date.now();
    }
  } catch (e) {
    // Сервер недоступен/не авторизованы — останемся на резервном публичном STUN,
    // звонки в пределах одной сети (или без строгого NAT) всё равно сработают.
  }
  return RTC_CONFIG;
}

$('#audioCallBtn').addEventListener('click', () => startCall('audio'));
$('#videoCallBtn').addEventListener('click', () => startCall('video'));
$('#hangupBtn').addEventListener('click', endCall);
$('#acceptCallBtn').addEventListener('click', acceptIncomingCall);
$('#declineCallBtn').addEventListener('click', declineIncomingCall);
$('#toggleMicBtn').addEventListener('click', toggleMic);
$('#toggleCamBtn').addEventListener('click', toggleCam);
$('#flipCamBtn').addEventListener('click', flipCamera);

let pendingOffer = null;
// Кандидаты ICE, пришедшие раньше, чем наш RTCPeerConnection готов их принять
// (пока идёт «звонок» на экране входящего вызова, или пока не установлено
// remoteDescription) — раньше такие кандидаты просто терялись, из-за чего
// звонок иногда не мог соединиться (чёрный экран без звука). Теперь они
// складываются в очередь и применяются, как только соединение готово.
let pendingCallIce = [];

function queueOrApplyCallIce(candidate) {
  if (!candidate) return;
  if (state.peerConn && state.peerConn.remoteDescription) {
    state.peerConn.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
  } else {
    pendingCallIce.push(candidate);
  }
}

function flushPendingCallIce() {
  if (!state.peerConn || !pendingCallIce.length) return;
  const queued = pendingCallIce;
  pendingCallIce = [];
  queued.forEach((c) => state.peerConn.addIceCandidate(new RTCIceCandidate(c)).catch(() => {}));
}

function toggleMic() {
  if (!state.localStream) return;
  state.micOn = !state.micOn;
  state.localStream.getAudioTracks().forEach((t) => { t.enabled = state.micOn; });
  $('#toggleMicBtn').classList.toggle('off', !state.micOn);
  if (state.currentCallPeerId) state.ws.send(JSON.stringify({ type: 'call-media-toggle', to: state.currentCallPeerId, kind: 'audio', enabled: state.micOn }));
}

function toggleCam() {
  if (!state.localStream) return;
  const tracks = state.localStream.getVideoTracks();
  if (!tracks.length) return;
  state.camOn = !state.camOn;
  tracks.forEach((t) => { t.enabled = state.camOn; });
  $('#toggleCamBtn').classList.toggle('off', !state.camOn);
  // при выключении своей камеры прячем собственный превью-квадрат, при включении — возвращаем
  $('#localVideo').classList.toggle('hidden', !state.camOn);
  // свою камеру выключили, пока своё видео было «большим» — на весь экран нечего
  // показывать, возвращаем чужое видео на большой экран
  if (!state.camOn && state.pipSwapped) swapPipVideos();
  updateRemoteVideoVisibility();
  if (state.currentCallPeerId) state.ws.send(JSON.stringify({ type: 'call-media-toggle', to: state.currentCallPeerId, kind: 'video', enabled: state.camOn }));
}

async function flipCamera() {
  if (!state.localStream || !state.hasCamera) return;
  const oldTrack = state.localStream.getVideoTracks()[0];
  if (!oldTrack) return;
  try {
    state.localStream.removeTrack(oldTrack);
    const { track: newTrack, facing } = await swapCameraTrack(oldTrack, state.currentFacingMode || 'user');
    newTrack.enabled = state.camOn;
    if (state.peerConn) {
      const sender = state.peerConn.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(newTrack);
    }
    state.localStream.addTrack(newTrack);
    $('#localVideo').srcObject = state.localStream;
    state.currentFacingMode = facing;
  } catch (e) {
    alert('Не удалось переключить камеру: ' + (e.message || 'неизвестная ошибка'));
  }
}

// Аудио- и видеозвонок технически устроены одинаково: у обоих сразу
// запрашивается доступ и к микрофону, и к камере (если камера есть), просто
// для «аудиозвонка» видеодорожка сразу выключается (enabled=false). Это даёт
// возможность включить камеру прямо во время разговора без пересоздания
// соединения — трек уже согласован, его достаточно просто «включить».
async function acquireCallMedia() {
  try {
    const stream = await getMedia({ video: { facingMode: state.currentFacingMode || 'user' }, audio: true }, { silent: true });
    state.hasCamera = stream.getVideoTracks().length > 0;
    return stream;
  } catch (e) {
    state.hasCamera = false;
    return await getMedia({ video: false, audio: true });
  }
}

function attachPeerConnectionHandlers(pc) {

  // ФИКС "звонок навсегда висит в checking/connecting, хотя watchdog
  // пытается его починить": restartIce() сам по себе НИЧЕГО не чинит — по
  // спецификации WebRTC он только просит ICE-агент пересобрать кандидаты с
  // новым ufrag/pwd и генерирует событие negotiationneeded. Чтобы рестарт
  // реально сработал, нужно самим создать новый offer с этими новыми
  // ICE-параметрами и отправить его собеседнику — иначе у собеседника
  // remoteDescription остаётся со старым ufrag, и новые кандидаты просто
  // не с чем сопоставить. Раньше этого обработчика не было вообще —
  // restartIce() вызывался (из oniceconnectionstatechange и media watchdog
  // ниже), но никакого нового offer/answer не уходило, и звонок оставался
  // сломанным навсегда, без единой ошибки в консоли.
  pc.onnegotiationneeded = async () => {
    // Срабатывает и на самое первое согласование (сразу после addTrack),
    // но там мы создаём offer сами вручную (см. startCall/acceptIncomingCall)
    // ДО того, как повесить этот обработчик — так что здесь это всегда
    // именно повторное согласование (в первую очередь — ICE restart).
    if (!state.currentCallPeerId || !state.currentCallId) return;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      state.ws.send(JSON.stringify({
        type: 'call-offer',
        to: state.currentCallPeerId,
        sdp: offer,
        callId: state.currentCallId,
        kind: state.camOn ? 'video' : 'audio',
        isRenegotiation: true,
      }));
    } catch (e) { /* негде показать пользователю — просто не отправится обновлённый offer */ }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      state.ws.send(JSON.stringify({ type: 'call-ice', to: state.currentCallPeerId, candidate: e.candidate }));
    }
  };
  pc.ontrack = (e) => {
    const stream = e.streams[0];
    $('#remoteVideo').srcObject = stream;
  };

  // ФИКС: первая версия этого фикса полностью завязывала показ "Соединено" и
  // запуск таймера на событие oniceconnectionstatechange === 'connected' — и
  // это сломало вообще все звонки ("бесконечное Соединение" у всех), потому
  // что это событие в реальных условиях срабатывает не всегда вовремя и не
  // всегда однозначно во всех браузерах. Возвращаем прежнее поведение по
  // умолчанию — "Соединено"/таймер запускаются сразу, как и было раньше и
  // как надёжно работало — а мониторинг настоящего состояния ICE оставляем
  // только для того, чтобы ЛОВИТЬ реальные обрывы/проблемы и пытаться их
  // чинить (restartIce), не блокируя обычный рабочий сценарий.
  let reconnectTimer = null;
  let sawRealFailure = false;
  pc.oniceconnectionstatechange = () => {
    const st = pc.iceConnectionState;
    if (st === 'connected' || st === 'completed') {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (sawRealFailure) { sawRealFailure = false; flashCallStatus('Соединено'); }
    } else if (st === 'disconnected') {
      // Часто восстанавливается само (кратковременная потеря пакетов) —
      // не рвём звонок, но пробуем помочь ICE переустановиться.
      flashCallStatus('Переподключение…');
      if (typeof pc.restartIce === 'function') { try { pc.restartIce(); } catch (e) {} }
    } else if (st === 'failed') {
      sawRealFailure = true;
      if (typeof pc.restartIce === 'function') { try { pc.restartIce(); } catch (e) {} }
      if (!reconnectTimer) {
        flashCallStatus('Проблемы с соединением…');
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (pc.iceConnectionState === 'failed') {
            alert('Не удалось установить соединение звонка. Проверьте интернет-соединение и попробуйте ещё раз.');
            endCall();
          }
        }, 8000);
      }
    }
  };
  pc.onconnectionstatechange = () => {};
  pc.onsignalingstatechange = () => {};

  // БАГ-ФИКС «чёрный экран/нет звука, хотя написано „Соединено“»: статус
  // "Соединено" и таймер выше запускаются оптимистично, сразу после обмена
  // SDP (см. комментарий выше про сломанные звонки у всех), не дожидаясь
  // iceConnectionState — а он, как выяснилось на практике, у части
  // пользователей вовсе не доходит до 'connected'/'failed', застревая в
  // 'checking' (или доходит, но реальные RTP-пакеты всё равно не идут —
  // например, наш собственный mini-turn.js успешно отвечает на STUN/TURN
  // Allocate/CreatePermission, но по каким-то причинам не может
  // ретранслировать сами медиаданные). В обоих случаях пользователь видит
  // "Соединено"/идущий таймер и чёрный экран — ровно то, о чём сообщают.
  //
  // Чиним не откатом старого фикса (это опять сломает "Соединение…" всем,
  // у кого просто иногда с опозданием стреляет iceConnectionState), а
  // независимой проверкой ПО ФАКТУ: реально ли идут байты входящего медиа
  // (через getStats → inbound-rtp), а не по событиям, которые ненадёжны.
  // Если через некоторое время после старта звонка байтов как не было, так
  // и нет — делается попытка restartIce(), плюс пользователю честно
  // показывается "Проблемы со связью…" вместо тикающего таймера над чёрным
  // экраном.
  let watchdogSawMedia = false;
  let watchdogTicks = 0;
  clearInterval(state.callMediaWatchdogInt);
  state.callMediaWatchdogInt = setInterval(async () => {
    if (!state.peerConn || state.peerConn !== pc || pc.connectionState === 'closed') {
      clearInterval(state.callMediaWatchdogInt);
      return;
    }
    watchdogTicks += 1;
    let totalBytes = 0;
    try {
      const stats = await pc.getStats();
      stats.forEach((r) => {
        if (r.type === 'inbound-rtp' && !r.isRemote) totalBytes += (r.bytesReceived || 0);
      });
    } catch (e) { return; }
    if (totalBytes > 0) {
      watchdogSawMedia = true;
      if (state.callMediaStuck) state.callMediaStuck = false;
      return;
    }
    // Даём звонку ~7 секунд (примерно 3-4 тика) на настоящее соединение,
    // прежде чем бить тревогу — это дольше, чем обычно занимает ICE по
    // прямому/STUN пути, но не настолько долго, чтобы человек решил, что
    // приложение просто зависло.
    if (!watchdogSawMedia && watchdogTicks >= 3) {
      state.callMediaStuck = true;
      if (typeof pc.restartIce === 'function') { try { pc.restartIce(); } catch (e) {} }
    }
  }, 2500);
}

async function startCall(kind) {
  const conv = state.conversations.find((c) => c.id === state.activeConvId);
  if (!conv || !conv.peer) return;
  state.currentCallPeerId = conv.peer.id;
  state.currentCallId = genCallId();
  state.callConnected = false;
  pendingCallIce = [];
  state.currentFacingMode = 'user';
  state.localStream = await acquireCallMedia();
  state.micOn = true;
  state.camOn = state.hasCamera && kind === 'video';
  state.remoteCamOn = kind === 'video';
  state.localStream.getVideoTracks().forEach((t) => { t.enabled = state.camOn; });
  await ensureRtcConfig();
  const pc = new RTCPeerConnection(RTC_CONFIG);
  state.peerConn = pc;
  state.localStream.getTracks().forEach((t) => pc.addTrack(t, state.localStream));
  attachPeerConnectionHandlers(pc);
  showCallOverlay(conv.peer, kind, true, conv.peer.id);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  state.ws.send(JSON.stringify({ type: 'call-offer', to: state.currentCallPeerId, sdp: offer, kind, callId: state.currentCallId }));
}

function genCallId() {
  return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('call_' + Date.now() + '_' + Math.random().toString(36).slice(2));
}

function handleCallSignal(msg) {
  if (msg.type === 'call-offer') {
    // ФИКС (см. onnegotiationneeded в attachPeerConnectionHandlers): это
    // не новый звонок, а повторный offer в РАМКАХ уже идущего звонка
    // (ICE restart после watchdog/сбоя) — применяем его напрямую к уже
    // существующему pc и отвечаем новым answer, вместо того чтобы
    // показывать экран "Входящий звонок" или (что было раньше) отклонять
    // его как второй параллельный вызов.
    if (msg.isRenegotiation && state.currentCallId === msg.callId && state.peerConn) {
      state.peerConn.setRemoteDescription(new RTCSessionDescription(msg.sdp))
        .then(() => state.peerConn.createAnswer())
        .then((answer) => state.peerConn.setLocalDescription(answer).then(() => answer))
        .then((answer) => {
          state.ws.send(JSON.stringify({
            type: 'call-answer', to: state.currentCallPeerId, sdp: answer,
            callId: state.currentCallId, isRenegotiation: true,
          }));
        })
        .catch(() => {});
      return;
    }
    // если уже идёт другой звонок — просто отклоняем новый, чтобы не путать состояние
    if (state.currentCallPeerId || !$('#callOverlay').classList.contains('hidden')) {
      state.ws.send(JSON.stringify({ type: 'call-decline', to: msg.from }));
      return;
    }
    pendingOffer = msg;
    const peerUser = findKnownUser(msg.from);
    const name = peerUser ? peerDisplayName(msg.from, peerUser) : 'Неизвестный';
    $('#incomingPeerName').textContent = name;
    $('#incomingText').textContent = `Входящий ${msg.kind === 'video' ? 'видео' : 'аудио'}звонок…`;
    const av = $('#incomingAvatarBig');
    av.textContent = peerUser && peerUser.avatar ? '' : initials(name);
    av.style.cssText = peerUser ? avatarStyle(peerUser) : '';
    if (!peerUser) {
      ensureUserCached(msg.from).then((u) => {
        if (!u || pendingOffer !== msg) return;
        const uName = peerDisplayName(msg.from, u);
        $('#incomingPeerName').textContent = uName;
        av.textContent = u.avatar ? '' : initials(uName);
        av.style.cssText = avatarStyle(u);
      });
    }
    showModal('#incomingCall');
    notifyIncomingCall(msg);
    startRingtone();
  } else if (msg.type === 'call-answer') {
    if (state.peerConn) {
      state.peerConn.setRemoteDescription(new RTCSessionDescription(msg.sdp)).then(flushPendingCallIce).catch(() => {});
    }
    // ФИКС: answer на повторный offer (ICE-restart, см. onnegotiationneeded)
    // не должен заново запускать гудки/таймер/статус "Соединено" — звонок
    // уже шёл, иначе счётчик времени звонка обнулялся бы при каждом
    // восстановлении соединения.
    if (!msg.isRenegotiation) {
      stopRingback(); // дозвонились — гудки больше не нужны
      $('#callStatus').textContent = 'Соединено';
      startCallTimer();
      syncMediaStateToPeer();
    }
  } else if (msg.type === 'call-ice') {
    queueOrApplyCallIce(msg.candidate);
  } else if (msg.type === 'call-end' || msg.type === 'call-decline') {
    // ключевой фикс: если собеседник отменил вызов до того, как мы ответили,
    // нужно закрыть и экран входящего звонка, и очистить pendingOffer —
    // иначе кнопка «Принять» попытается ответить на уже мёртвый вызов.
    pendingOffer = null;
    closeActiveCallNotification();
    stopRingtone();
    stopRingback();
    $('#incomingCall').classList.add('hidden');
    cleanupCall();
  } else if (msg.type === 'call-taken-elsewhere') {
    // ФИКС: собеседник открыт на нескольких устройствах — если этот же
    // входящий звонок уже приняли/отклонили на другом устройстве, здесь
    // просто убираем экран "Входящий звонок", не трогая уже установленное
    // соединение (если оно вдруг тут есть — но обычно на этом устройстве
    // звонок ещё даже не был принят, так что pendingOffer точно есть).
    if (pendingOffer && pendingOffer.callId === msg.callId) {
      pendingOffer = null;
      closeActiveCallNotification();
      stopRingtone();
      $('#incomingCall').classList.add('hidden');
    }
  } else if (msg.type === 'call-media-toggle') {
    if (msg.kind === 'video') {
      state.remoteCamOn = msg.enabled;
      updateRemoteVideoVisibility();
    } else {
      flashCallStatus(`Собеседник ${msg.enabled ? 'включил' : 'выключил'} микрофон`);
    }
  }
}

function updateRemoteVideoVisibility() {
  // БАГ «если выключить камеру человеку, у которого стоит иконка, иконка
  // накладывается на видео»: после «свапа» (тап по маленькому окну — своё видео
  // на весь экран, чужое в углу) собеседник выключает камеру, чужое видео
  // скрывается, а его большая иконка-аватар (#callAvatarBig, поверх всего)
  // рисовалась ПОВЕРХ нашего видео на весь экран. Если большого видео
  // собеседника нет, возвращаем раскладку по умолчанию: его иконка на фоне,
  // своё видео — в маленьком окне.
  if (!state.remoteCamOn && state.pipSwapped) swapPipVideos();
  $('#remoteVideo').classList.toggle('hidden', !state.remoteCamOn);
  const localIsBig = !!state.pipSwapped && !!state.camOn;
  $('#callAvatarBig').classList.toggle('hidden', !!state.remoteCamOn || localIsBig);
}

// сообщаем собеседнику наше текущее состояние камеры сразу после соединения —
// это подстраховка на случай, если он успел переключить что-то ещё до ответа
function syncMediaStateToPeer() {
  if (!state.currentCallPeerId) return;
  state.ws.send(JSON.stringify({ type: 'call-media-toggle', to: state.currentCallPeerId, kind: 'video', enabled: state.camOn }));
}

function flashCallStatus(text) {
  const el = $('#callStatus');
  const prev = el.dataset.timerRunning === '1' ? null : el.textContent;
  el.textContent = text;
  setTimeout(() => { if (el.dataset.timerRunning !== '1' && prev !== null) el.textContent = prev; }, 2000);
}

async function acceptIncomingCall() {
  if (!pendingOffer) return;
  stopRingtone();
  closeActiveCallNotification();
  $('#incomingCall').classList.add('hidden');
  state.currentCallPeerId = pendingOffer.from;
  state.currentCallId = pendingOffer.callId;
  state.callConnected = false;
  pendingCallIce = [];
  state.currentFacingMode = 'user';
  state.localStream = await acquireCallMedia();
  state.micOn = true;
  state.camOn = state.hasCamera && pendingOffer.kind === 'video';
  state.remoteCamOn = pendingOffer.kind === 'video';
  state.localStream.getVideoTracks().forEach((t) => { t.enabled = state.camOn; });
  await ensureRtcConfig();
  const pc = new RTCPeerConnection(RTC_CONFIG);
  state.peerConn = pc;
  state.localStream.getTracks().forEach((t) => pc.addTrack(t, state.localStream));
  attachPeerConnectionHandlers(pc);
  await pc.setRemoteDescription(new RTCSessionDescription(pendingOffer.sdp));
  flushPendingCallIce();
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  state.ws.send(JSON.stringify({ type: 'call-answer', to: state.currentCallPeerId, sdp: answer, callId: state.currentCallId }));
  const peerUser = findKnownUser(pendingOffer.from);
  showCallOverlay(peerUser || { displayName: 'Собеседник' }, pendingOffer.kind, false, pendingOffer.from);
  startCallTimer();
  syncMediaStateToPeer();
  pendingOffer = null;
}

function declineIncomingCall() {
  if (pendingOffer) state.ws.send(JSON.stringify({ type: 'call-decline', to: pendingOffer.from, callId: pendingOffer.callId }));
  pendingOffer = null;
  stopRingtone();
  closeActiveCallNotification();
  $('#incomingCall').classList.add('hidden');
}

function showCallOverlay(peerUser, kind, outgoing, peerUserId) {
  // Гудки вызова — только у того, кто звонит (outgoing). У того, кому
  // звонят, играет рингтон — он запускается отдельно, в handleCallSignal
  // при получении call-offer, ещё до того, как этот экран вообще открыт
  // (человек сначала видит/слышит входящий звонок и только потом решает
  // принять — тогда этот экран и появится).
  if (outgoing) startRingback();
  const name = peerDisplayName(peerUserId != null ? peerUserId : (peerUser && peerUser.id), peerUser);
  $('#callPeerName').textContent = name;
  $('#callStatus').textContent = outgoing ? 'Вызов…' : 'Соединение…';
  $('#callStatus').dataset.timerRunning = '0';
  const av = $('#callAvatarBig');
  av.textContent = peerUser.avatar ? '' : initials(name);
  av.style.cssText = avatarStyle(peerUser);
  showModal('#callOverlay');
  $('#toggleMicBtn').classList.remove('off');
  $('#toggleCamBtn').classList.toggle('off', !state.camOn);

  const hasCamera = !!state.hasCamera;
  $('#toggleCamBtn').classList.toggle('hidden', !hasCamera);
  $('#flipCamBtn').classList.toggle('hidden', !hasCamera);

  // сбрасываем роли «большой экран / перетаскиваемый PIP» на дефолт для нового звонка
  state.pipSwapped = false;
  $('#remoteVideo').classList.add('vid-big'); $('#remoteVideo').classList.remove('vid-pip');
  $('#localVideo').classList.add('vid-pip'); $('#localVideo').classList.remove('vid-big');
  resetPipPosition();

  const localVideo = $('#localVideo');
  localVideo.srcObject = state.localStream;
  localVideo.classList.toggle('hidden', !state.camOn);

  updateRemoteVideoVisibility();
}

/* ---- Перетаскиваемый и меняемый местами PIP (свой/чужой вид в звонке) ---- */

function resetPipPosition() {
  ['remoteVideo', 'localVideo'].forEach((id) => {
    const el = $('#' + id);
    el.style.left = ''; el.style.top = ''; el.style.right = '';
  });
}

function swapPipVideos() {
  ['remoteVideo', 'localVideo'].forEach((id) => {
    const el = $('#' + id);
    el.classList.toggle('vid-big');
    el.classList.toggle('vid-pip');
  });
  resetPipPosition();
  state.pipSwapped = !state.pipSwapped;
}

function setupPipDraggable(el) {
  let dragging = false, moved = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
  el.addEventListener('pointerdown', (e) => {
    if (!el.classList.contains('vid-pip')) return;
    dragging = true; moved = false;
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    const rect = el.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    startLeft = rect.left; startTop = rect.top;
    el.classList.add('dragging');
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
    if (!moved) return;
    const screen = el.closest('.call-screen') || document.body;
    const bounds = screen.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    let newLeft = Math.max(bounds.left + 8, Math.min(startLeft + dx, bounds.right - w - 8));
    let newTop = Math.max(bounds.top + 8, Math.min(startTop + dy, bounds.bottom - h - 8));
    el.style.left = (newLeft - bounds.left) + 'px';
    el.style.top = (newTop - bounds.top) + 'px';
    el.style.right = 'auto';
  });
  function finishDrag() {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    // менять местами нечего, если у собеседника выключена камера (его видео
    // скрыто) — иначе своё видео ушло бы на весь экран, а иконка-аватар
    // собеседника легла бы поверх него
    if (!moved && state.remoteCamOn) swapPipVideos();
  }
  el.addEventListener('pointerup', finishDrag);
  el.addEventListener('pointercancel', finishDrag);
}
setupPipDraggable($('#remoteVideo'));
setupPipDraggable($('#localVideo'));

function startCallTimer() {
  state.callStartedAt = Date.now();
  state.callMediaStuck = false;
  $('#callStatus').dataset.timerRunning = '1';
  clearInterval(state.callTimerInt);
  state.callTimerInt = setInterval(() => {
    // Пока media watchdog (см. attachPeerConnectionHandlers) видит 0 байт
    // реального входящего медиа — честно показываем это в статусе вместо
    // тикающего таймера, который иначе создаёт впечатление рабочего звонка
    // при чёрном экране/тишине.
    if (state.callMediaStuck) {
      $('#callStatus').textContent = 'Проблемы со связью…';
      return;
    }
    const sec = Math.floor((Date.now() - state.callStartedAt) / 1000);
    $('#callStatus').textContent = `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`;
  }, 1000);
}

function endCall() {
  if (state.currentCallPeerId) state.ws.send(JSON.stringify({ type: 'call-end', to: state.currentCallPeerId, callId: state.currentCallId }));
  cleanupCall();
}

function cleanupCall() {
  // Подстраховка: чем бы звонок ни закончился (свой обрыв связи, ошибка
  // WebRTC, обычное завершение) — гудки/рингтон точно не должны продолжать
  // играть после того, как экран звонка исчез.
  stopRingback();
  stopRingtone();
  if (state.peerConn) { state.peerConn.close(); state.peerConn = null; }
  pendingCallIce = [];
  if (state.localStream) { state.localStream.getTracks().forEach((t) => t.stop()); state.localStream = null; }
  clearInterval(state.callTimerInt);
  state.callTimerInt = null;
  clearInterval(state.callMediaWatchdogInt);
  state.callMediaWatchdogInt = null;
  state.callMediaStuck = false;
  state.currentCallPeerId = null;
  state.currentCallId = null;
  state.callConnected = false;
  state.hasCamera = false;
  state.pipSwapped = false;
  resetPipPosition();
  $('#callOverlay').classList.add('hidden');
  $('#remoteVideo').srcObject = null;
  $('#localVideo').srcObject = null;
  $('#remoteVideo').classList.add('hidden');
  $('#localVideo').classList.add('hidden');
  $('#callAvatarBig').classList.remove('hidden');
  if (state.activeSection === 'calls') loadCallHistory();
}

/* ---------------- ГРУППОВЫЕ ЗВОНКИ В КАНАЛАХ (mesh: каждый с каждым) ---------------- */

let groupCall = null; // { conversationId, localStream, pcs: Map<userId, RTCPeerConnection>, micOn, camOn, hasCamera, facingMode }

function updateGroupCallButton(conv) {
  const btn = $('#groupCallBtn');
  if (!conv || conv.type !== 'group' || conv.groupCallsEnabled === false) {
    btn.classList.add('hidden');
    return;
  }
  btn.classList.remove('hidden');
  const count = conv.groupCallCount || 0;
  btn.textContent = count > 0 ? `🎧 ${count}` : '🎧';
  btn.title = count > 0 ? `Присоединиться (сейчас ${count})` : 'Начать групповой звонок';
}

$('#groupCallBtn').addEventListener('click', () => {
  const conv = state.conversations.find((c) => c.id === state.activeConvId);
  if (conv) startOrJoinGroupCall(conv);
});

$('#groupCallShareBtn').addEventListener('click', () => {
  if (!groupCall) return;
  const conv = state.conversations.find((c) => c.id === groupCall.conversationId);
  if (!conv || !conv.inviteCode) return;
  openShareModal(`Звонок в «${conv.name}»`, buildInviteLink(conv.inviteCode));
});

async function startOrJoinGroupCall(conv) {
  if (groupCall) { alert('Вы уже участвуете в другом групповом звонке. Сначала покиньте его.'); return; }
  if (state.currentCallPeerId) { alert('Сначала завершите обычный звонок.'); return; }
  await ensureRtcConfig();
  let localStream;
  try {
    localStream = await acquireCallMedia();
  } catch (e) { return; }
  groupCall = {
    conversationId: conv.id,
    localStream,
    pcs: new Map(),
    micOn: true,
    camOn: state.hasCamera,
    hasCamera: state.hasCamera,
    facingMode: 'user',
  };
  localStream.getVideoTracks().forEach((t) => { t.enabled = groupCall.camOn; });

  $('#groupCallTitle').textContent = conv.name;
  $('#groupCallStatus').textContent = 'Подключение…';
  $('#groupCallGrid').innerHTML = '';
  $('#groupToggleMicBtn').classList.remove('off');
  $('#groupToggleCamBtn').classList.toggle('off', !groupCall.camOn);
  $('#groupToggleCamBtn').classList.toggle('hidden', !groupCall.hasCamera);
  $('#groupFlipCamBtn').classList.toggle('hidden', !groupCall.hasCamera);
  addOrUpdateGroupTile('self', state.user, localStream, true, !groupCall.camOn);
  showModal('#groupCallOverlay');

  state.ws.send(JSON.stringify({ type: 'group-call-join', conversationId: conv.id, kind: groupCall.hasCamera ? 'video' : 'audio' }));
}

function addOrUpdateGroupTile(userId, userObj, stream, isSelf, camOff) {
  let tile = document.getElementById('gc-tile-' + userId);
  const name = userObj ? userObj.displayName : 'Участник';
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'group-call-tile';
    tile.id = 'gc-tile-' + userId;
    $('#groupCallGrid').appendChild(tile);
  }
  const showVideo = stream && stream.getVideoTracks().length && !camOff;
  tile.innerHTML = showVideo
    ? `<video autoplay playsinline ${isSelf ? 'muted' : ''}></video><div class="tile-label">${isSelf ? '' : '🔊 '}${escapeHtml(name)}</div>`
    : `<div class="tile-avatar">${initials(name)}</div><div class="tile-label">${escapeHtml(name)} <span class="tile-muted">🎙 выкл. камеры</span></div>`;
  if (showVideo) tile.querySelector('video').srcObject = stream;
}

function removeGroupTile(userId) {
  const tile = document.getElementById('gc-tile-' + userId);
  if (tile) tile.remove();
}

function createGroupPeerConnection(peerId) {
  ensureRtcConfig(); // не блокируем — просто освежаем креды в фоне, если истекают
  const pc = new RTCPeerConnection(RTC_CONFIG);
  groupCall.localStream.getTracks().forEach((t) => pc.addTrack(t, groupCall.localStream));
  pc.onicecandidate = (e) => {
    if (e.candidate) state.ws.send(JSON.stringify({ type: 'group-call-ice', conversationId: groupCall.conversationId, to: peerId, candidate: e.candidate }));
  };
  pc.ontrack = (e) => {
    const peerUser = findKnownUser(peerId);
    addOrUpdateGroupTile(peerId, peerUser, e.streams[0], false, false);
    if (!peerUser) {
      ensureUserCached(peerId).then((u) => {
        if (u && groupCall && groupCall.pcs.has(peerId)) addOrUpdateGroupTile(peerId, u, e.streams[0], false, false);
      });
    }
  };
  groupCall.pcs.set(peerId, pc);
  return pc;
}

async function handleGroupCallSignal(msg) {
  if (!groupCall || msg.conversationId !== groupCall.conversationId) {
    // сигнал по звонку, в котором мы не участвуем (например, уже вышли) — игнорируем
    if (msg.type !== 'group-call-state') return;
  }
  if (msg.type === 'group-call-state') {
    if (!groupCall) return;
    $('#groupCallStatus').textContent = msg.participants.length ? `Участников: ${msg.participants.length + 1}` : 'Ожидание собеседников…';
    for (const peerId of msg.participants) {
      const pc = createGroupPeerConnection(peerId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      state.ws.send(JSON.stringify({ type: 'group-call-offer', conversationId: groupCall.conversationId, to: peerId, sdp: offer }));
    }
  } else if (msg.type === 'group-call-offer') {
    if (!groupCall) return;
    const pc = groupCall.pcs.get(msg.from) || createGroupPeerConnection(msg.from);
    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    state.ws.send(JSON.stringify({ type: 'group-call-answer', conversationId: groupCall.conversationId, to: msg.from, sdp: answer }));
  } else if (msg.type === 'group-call-answer') {
    if (!groupCall) return;
    const pc = groupCall.pcs.get(msg.from);
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
  } else if (msg.type === 'group-call-ice') {
    if (!groupCall) return;
    const pc = groupCall.pcs.get(msg.from);
    if (pc && msg.candidate) pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
  } else if (msg.type === 'group-call-peer-joined') {
    if (!groupCall) return;
    $('#groupCallStatus').textContent = `Участников: ${groupCall.pcs.size + 2}`;
    // ждём офер от нового участника — сами не звоним, чтобы не было дублей соединений
  } else if (msg.type === 'group-call-peer-left') {
    if (!groupCall) return;
    const pc = groupCall.pcs.get(msg.userId);
    if (pc) { pc.close(); groupCall.pcs.delete(msg.userId); }
    removeGroupTile(msg.userId);
    $('#groupCallStatus').textContent = `Участников: ${groupCall.pcs.size + 1}`;
  }
}

function toggleGroupMic() {
  if (!groupCall) return;
  groupCall.micOn = !groupCall.micOn;
  groupCall.localStream.getAudioTracks().forEach((t) => { t.enabled = groupCall.micOn; });
  $('#groupToggleMicBtn').classList.toggle('off', !groupCall.micOn);
}

function toggleGroupCam() {
  if (!groupCall) return;
  const tracks = groupCall.localStream.getVideoTracks();
  if (!tracks.length) return;
  groupCall.camOn = !groupCall.camOn;
  tracks.forEach((t) => { t.enabled = groupCall.camOn; });
  $('#groupToggleCamBtn').classList.toggle('off', !groupCall.camOn);
  addOrUpdateGroupTile('self', state.user, groupCall.localStream, true, !groupCall.camOn);
}

async function flipGroupCamera() {
  if (!groupCall || !groupCall.hasCamera) return;
  const oldTrack = groupCall.localStream.getVideoTracks()[0];
  if (!oldTrack) return;
  try {
    groupCall.localStream.removeTrack(oldTrack);
    const { track: newTrack, facing } = await swapCameraTrack(oldTrack, groupCall.facingMode || 'user');
    newTrack.enabled = groupCall.camOn;
    groupCall.pcs.forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(newTrack);
    });
    groupCall.localStream.addTrack(newTrack);
    groupCall.facingMode = facing;
    addOrUpdateGroupTile('self', state.user, groupCall.localStream, true, !groupCall.camOn);
  } catch (e) {
    alert('Не удалось переключить камеру: ' + (e.message || 'неизвестная ошибка'));
  }
}

function leaveGroupCallLocal() {
  if (!groupCall) return;
  state.ws.send(JSON.stringify({ type: 'group-call-leave', conversationId: groupCall.conversationId }));
  groupCall.pcs.forEach((pc) => pc.close());
  groupCall.localStream.getTracks().forEach((t) => t.stop());
  groupCall = null;
  $('#groupCallOverlay').classList.add('hidden');
  $('#groupCallGrid').innerHTML = '';
  if (state.activeSection === 'calls') loadCallHistory();
}

$('#groupToggleMicBtn').addEventListener('click', toggleGroupMic);
$('#groupToggleCamBtn').addEventListener('click', toggleGroupCam);
$('#groupFlipCamBtn').addEventListener('click', flipGroupCamera);
$('#groupHangupBtn').addEventListener('click', leaveGroupCallLocal);

/* ---------------- ADMIN PANEL (теперь отдельный раздел) ---------------- */

$('#adminRevokeSelfBtn').addEventListener('click', async () => {
  if (!confirm('Снять с себя права администратора? Раздел «Админ» пропадёт, вернуть доступ можно будет снова написав боту команду.')) return;
  try {
    await api(`/api/admin/users/${state.user.id}`, { method: 'PATCH', body: { isAdmin: false } });
    state.user.isAdmin = false;
    $('#adminNavBtn').classList.add('hidden');
    $('#openAdminFromSettingsBtn').classList.add('hidden');
    switchSection('chats');
  } catch (err) { alert(err.message); }
});

$all('.modal-tab[data-atab]').forEach((tab) => {
  tab.addEventListener('click', () => {
    $all('.modal-tab[data-atab]').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const t = tab.dataset.atab;
    $('#adminUsersTab').classList.toggle('hidden', t !== 'users');
    $('#adminChatsTab').classList.toggle('hidden', t !== 'chats');
    $('#adminApkTab').classList.toggle('hidden', t !== 'apk');
    $('#adminBannerTab').classList.toggle('hidden', t !== 'banner');
    $('#adminRegistrationTab').classList.toggle('hidden', t !== 'registration');
    $('#adminExportTab').classList.toggle('hidden', t !== 'export');
  });
});

async function openAdminPanel() {
  await Promise.all([renderAdminUsers(), renderAdminChats(), renderAdminApk(), renderAdminBanner(), renderAdminRegistration(), renderAdminExport()]);
}

function renderAdminExport() {
  const el = $('#adminExportTab');
  el.innerHTML = `
    <div class="chat-header-sub" style="padding: 4px 2px 14px;">
      Полная выгрузка всех данных сервера — пользователи, все чаты и сообщения, звонки, контакты и т.д. Доступно два формата.
    </div>
    <div class="settings-list-group" style="padding:14px; display:flex; flex-direction:column; gap:6px;">
      <div style="font-weight:600;">🗜️ Полный архив (.zip) — для переезда на другой сервер</div>
      <div class="chat-header-sub" style="padding:0;">База данных + все загруженные файлы (аватарки, обои, сторис) одним архивом. На новом сервере достаточно распаковать этот zip прямо в домашнюю папку пользователя, от которого запускается сервер (<code>unzip asteria-full-backup-....zip -d ~</code>) — раскладывать файлы по подпапкам вручную не нужно.</div>
      <a class="btn-primary" id="exportArchiveBtn" href="/api/admin/export/archive" style="text-align:center; text-decoration:none; margin-top:6px;">Скачать архив .zip</a>
    </div>
    <div class="settings-list-group" style="padding:14px; display:flex; flex-direction:column; gap:6px; margin-top:12px;">
      <div style="font-weight:600;">📦 Только файл базы данных (.db)</div>
      <div class="chat-header-sub" style="padding:0;">Без загруженных файлов — только сами записи (пользователи, чаты, сообщения и т.д.). Пригодится, если файлы переносите отдельно.</div>
      <a class="btn-secondary" id="exportDbBtn" href="/api/admin/export/db" style="text-align:center; text-decoration:none; margin-top:6px;">Скачать .db</a>
    </div>
    <div class="settings-list-group" style="padding:14px; display:flex; flex-direction:column; gap:6px; margin-top:12px;">
      <div style="font-weight:600;">📄 JSON</div>
      <div class="chat-header-sub" style="padding:0;">Человекочитаемый формат — удобно посмотреть данные глазами или перенести куда-то ещё, помимо SQLite.</div>
      <a class="btn-secondary" id="exportJsonBtn" href="/api/admin/export/json" style="text-align:center; text-decoration:none; margin-top:6px;">Скачать .json</a>
    </div>
    <div class="settings-footnote" style="padding:14px 2px 0;">⚠️ Выгрузка содержит все данные без исключений, включая служебные (сессии, push-подписки). Храните файл так же аккуратно, как сам доступ к серверу.</div>
  `;
}

async function renderAdminUsers() {
  const { users } = await api('/api/admin/users');
  users.forEach((u) => { state.usersById[u.id] = u; });
  const el = $('#adminUsersTab');
  el.innerHTML = '';
  users.forEach((u) => {
    const row = document.createElement('div');
    row.className = 'admin-user-row';
    const canDelete = !u.isBot && u.id !== state.user.id;
    const canDeleteBot = !!u.isBot;
    row.innerHTML = `
      <div class="avatar${avatarRingClass(u)}" style="${u.avatar ? avatarStyle(u) : ''}">${u.avatar ? '' : initials(u.displayName)}</div>
      <div class="grow">
        <div class="name">${escapeHtml(u.displayName)}${verifiedBadge(u)} ${u.isAdmin ? '<span class="admin-badge">admin</span>' : ''} ${u.isBot ? '🤖' : ''}</div>
        <div class="sub">@${escapeHtml(u.username)}</div>
      </div>
      <button class="btn-secondary" data-verify="${u.id}">${u.isVerified ? 'Снять галочку' : '✔️ Верифицировать'}</button>
      <button class="btn-secondary" data-edit="${u.id}">Изменить</button>
      ${canDelete ? `<button class="btn-danger" data-del="${u.id}">Удалить</button>` : ''}
      ${canDeleteBot ? `<button class="btn-danger" data-del-bot="${u.id}">Удалить бота</button>` : ''}
    `;
    el.appendChild(row);
  });
  el.querySelectorAll('[data-verify]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const u = users.find((x) => x.id === btn.dataset.verify);
      try {
        await api(`/api/admin/users/${btn.dataset.verify}`, { method: 'PATCH', body: { isVerified: !u.isVerified } });
        renderAdminUsers();
      } catch (err) { alert(err.message); }
    });
  });
  el.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => openAdminEditUser(btn.dataset.edit, users));
  });
  el.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const u = users.find((x) => x.id === btn.dataset.del);
      if (!confirm(`Удалить аккаунт «${u.displayName}» (@${u.username}) безвозвратно? Его чаты и каналы тоже будут удалены.`)) return;
      try {
        await api(`/api/admin/users/${btn.dataset.del}`, { method: 'DELETE' });
        renderAdminUsers();
      } catch (err) { alert(err.message); }
    });
  });
  el.querySelectorAll('[data-del-bot]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const u = users.find((x) => x.id === btn.dataset.delBot);
      if (!confirm(`Удалить бота «${u.displayName}» (@${u.username}) безвозвратно? Переписки с ним тоже будут удалены.`)) return;
      try {
        await api(`/api/bots/${btn.dataset.delBot}`, { method: 'DELETE' });
        renderAdminUsers();
      } catch (err) { alert(err.message); }
    });
  });
}

let adminEditingUserId = null;
function openAdminEditUser(userId, users) {
  const u = users.find((x) => x.id === userId);
  if (!u) return;
  adminEditingUserId = userId;
  $('#adminEditDisplayName').value = u.displayName || '';
  $('#adminEditUsername').value = u.username || '';
  $('#adminEditStatus').value = u.status || '';
  $('#adminEditPassword').value = '';
  $('#adminEditError').textContent = '';
  const av = $('#adminEditAvatarPreview');
  av.textContent = u.avatar ? '' : initials(u.displayName);
  av.style.cssText = avatarStyle(u);
  av.dataset.avatarUrl = u.avatar || '';
  showModal('#adminEditUserModal');
}
$('#adminChangeAvatarBtn').addEventListener('click', () => $('#adminAvatarInput').click());
$('#adminAvatarInput').addEventListener('change', async () => {
  const file = $('#adminAvatarInput').files[0];
  if (!file) return;
  const url = await uploadFile(file, 'avatar');
  const av = $('#adminEditAvatarPreview');
  av.dataset.avatarUrl = url;
  av.style.cssText = `background-image:url('${url}')`;
  av.textContent = '';
});
$('#adminSaveUserBtn').addEventListener('click', async () => {
  $('#adminEditError').textContent = '';
  const patch = {
    displayName: $('#adminEditDisplayName').value.trim(),
    username: $('#adminEditUsername').value.trim(),
    status: $('#adminEditStatus').value.trim(),
    avatar: $('#adminEditAvatarPreview').dataset.avatarUrl || '',
  };
  const newPassword = $('#adminEditPassword').value;
  if (newPassword) patch.newPassword = newPassword;
  try {
    await api(`/api/admin/users/${adminEditingUserId}`, { method: 'PATCH', body: patch });
    $('#adminEditUserModal').classList.add('hidden');
    renderAdminUsers();
  } catch (err) { $('#adminEditError').textContent = err.message; }
});

async function renderAdminChats() {
  const { conversations } = await api('/api/admin/conversations');
  const el = $('#adminChatsTab');
  el.innerHTML = '';
  conversations.forEach((c) => {
    const canVerify = c.type === 'channel' || c.type === 'group';
    const canDelete = c.type === 'channel' || c.type === 'group';
    const row = document.createElement('div');
    row.className = 'admin-chat-row';
    row.innerHTML = `
      <div class="avatar">${initials(c.title || c.name || '?')}</div>
      <div class="grow">
        <div class="name">${escapeHtml(c.title || c.name)}${canVerify ? verifiedBadge(c) + rknBadge(c) : ''} ${c.type === 'channel' ? '📢' : c.type === 'group' ? '👥' : ''}</div>
        <div class="sub">${c.messageCount} сообщений</div>
      </div>
      ${canVerify ? `<button class="btn-secondary" data-verify-conv="${c.id}">${c.isVerified ? 'Снять галочку' : '✔️ Верифицировать'}</button>` : ''}
      ${canVerify ? `<button class="btn-secondary" data-rkn-conv="${c.id}">${c.isRegistered ? 'Снять A+' : 'A+ В перечне РКН'}</button>` : ''}
      <button class="btn-secondary" data-view="${c.id}">Просмотреть</button>
      ${canDelete ? `<button class="btn-danger" data-del-conv="${c.id}">Удалить</button>` : ''}
    `;
    el.appendChild(row);
  });
  el.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => openAdminChatView(btn.dataset.view, conversations));
  });
  el.querySelectorAll('[data-verify-conv]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const c = conversations.find((x) => x.id === btn.dataset.verifyConv);
      try {
        await api(`/api/admin/conversations/${btn.dataset.verifyConv}`, { method: 'PATCH', body: { isVerified: !c.isVerified } });
        renderAdminChats();
      } catch (err) { alert(err.message); }
    });
  });
  el.querySelectorAll('[data-rkn-conv]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const c = conversations.find((x) => x.id === btn.dataset.rknConv);
      try {
        await api(`/api/admin/conversations/${btn.dataset.rknConv}`, { method: 'PATCH', body: { isRegistered: !c.isRegistered } });
        renderAdminChats();
      } catch (err) { alert(err.message); }
    });
  });
  el.querySelectorAll('[data-del-conv]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const c = conversations.find((x) => x.id === btn.dataset.delConv);
      const kind = c.type === 'channel' ? 'канал' : 'группу';
      if (!confirm(`Удалить ${kind} «${c.title || c.name}» безвозвратно? Вся переписка в нём тоже будет удалена.`)) return;
      try {
        await api(`/api/conversations/${btn.dataset.delConv}`, { method: 'DELETE' });
        renderAdminChats();
      } catch (err) { alert(err.message); }
    });
  });
}

async function openAdminChatView(convId, conversations) {
  const conv = conversations.find((c) => c.id === convId);
  $('#adminChatViewTitle').textContent = conv ? (conv.title || conv.name) : 'Чат';
  const { messages } = await api(`/api/admin/conversations/${convId}/messages`);
  const el = $('#adminChatMessages');
  el.innerHTML = '';
  messages.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'admin-msg-row';
    const sender = state.usersById[m.senderId];
    const label = sender ? sender.displayName : m.senderId;
    row.innerHTML = `
      <div>
        <div><b>${escapeHtml(label)}:</b> ${escapeHtml(previewText(m))}</div>
        <div class="admin-msg-meta">${fmtTime(m.createdAt)} · ${fmtDate(m.createdAt)}</div>
      </div>
      <button data-del="${m.id}">Удалить</button>
    `;
    el.appendChild(row);
  });
  el.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Удалить сообщение?')) return;
      await api(`/api/messages/${btn.dataset.del}`, { method: 'DELETE' });
      openAdminChatView(convId, conversations);
      renderAdminChats();
    });
  });
  showModal('#adminChatViewModal');
}

/* ---------------- АДМИН: обновление Android-приложения ---------------- */

function fmtBytes(n) {
  if (!n) return '0 МБ';
  return (n / (1024 * 1024)).toFixed(1) + ' МБ';
}

async function renderAdminApk() {
  const el = $('#adminApkTab');
  const { release } = await api('/api/admin/app-release');

  el.innerHTML = `
    <div class="admin-apk-current">
      ${release ? `
        <div class="admin-apk-current-title">Сейчас раздаётся пользователям (${release.enabled ? 'включено' : 'выключено'}):</div>
        <div class="admin-apk-current-row">
          <div>
            <b>Версия ${escapeHtml(release.versionName)}</b> (versionCode ${release.versionCode}) · ${fmtBytes(release.sizeBytes)}
            <div class="admin-msg-meta">Загружено ${fmtDate(release.uploadedAt)} · ${escapeHtml(release.uploadedBy || '')}</div>
            ${release.notes ? `<div class="admin-apk-notes">${escapeHtml(release.notes)}</div>` : ''}
          </div>
          <div style="display:flex; gap:8px; flex-shrink:0;">
            <button class="btn-secondary" id="apkToggleBtn">${release.enabled ? 'Выключить' : 'Включить'}</button>
            ${release.enabled ? `<a class="btn-secondary" href="/api/app/download" target="_blank" rel="noopener">Скачать</a>` : ''}
          </div>
        </div>
        ${!release.enabled ? `<div class="admin-msg-meta">Автообновление выключено: файл не раздаётся, диалог в приложении и баннер на сайте никому не показываются — как будто обновления вообще не публиковали.</div>` : ''}
      ` : `<div class="admin-msg-meta">Пока ничего не загружено — приложения на телефонах будут работать без проверки обновлений.</div>`}
    </div>

    <div class="admin-apk-upload-form">
      <div class="admin-apk-current-title">Загрузить новую версию</div>
      <label class="field-label">Файл .apk</label>
      <input type="file" id="apkFileInput" accept=".apk,application/vnd.android.package-archive">
      <label class="field-label">versionCode (целое число, обязательно больше текущего — из build.gradle новой сборки)</label>
      <input type="number" id="apkVersionCode" min="1" step="1" placeholder="Например: 2">
      <label class="field-label">versionName (просто для отображения пользователям)</label>
      <input type="text" id="apkVersionName" placeholder="Например: 1.1">
      <label class="field-label">Что нового (необязательно)</label>
      <textarea id="apkNotes" rows="3" placeholder="Коротко опишите, что изменилось"></textarea>
      <button class="btn-primary" id="apkUploadBtn">Загрузить и опубликовать</button>
      <div class="admin-msg-meta" id="apkUploadStatus"></div>
    </div>
  `;

  if (release) {
    $('#apkToggleBtn').addEventListener('click', async () => {
      await api('/api/admin/app-release/toggle', { method: 'POST' });
      renderAdminApk();
    });
  }

  $('#apkUploadBtn').addEventListener('click', async () => {
    const fileInput = $('#apkFileInput');
    const file = fileInput.files[0];
    const versionCode = parseInt($('#apkVersionCode').value, 10);
    const versionName = $('#apkVersionName').value.trim();
    const notes = $('#apkNotes').value.trim();
    const statusEl = $('#apkUploadStatus');

    if (!file) { statusEl.textContent = 'Выберите файл .apk'; return; }
    if (!Number.isInteger(versionCode) || versionCode <= 0) { statusEl.textContent = 'versionCode должен быть положительным целым числом'; return; }
    if (!versionName) { statusEl.textContent = 'Укажите versionName'; return; }

    const btn = $('#apkUploadBtn');
    btn.disabled = true;
    statusEl.textContent = `Загружаю (${fmtBytes(file.size)})…`;
    try {
      const dataBase64 = await fileToBase64(file);
      await api('/api/admin/app-release', { method: 'POST', body: { versionCode, versionName, notes, dataBase64 } });
      statusEl.textContent = '✅ Новая версия опубликована — приложения предложат её пользователям при следующем запуске.';
      renderAdminApk();
    } catch (e) {
      statusEl.textContent = '❌ ' + (e.message || 'Не удалось загрузить APK');
    } finally {
      btn.disabled = false;
    }
  });
}

/* ---------------- АДМИН: открыть/закрыть регистрацию ---------------- */

async function renderAdminRegistration() {
  const el = $('#adminRegistrationTab');
  const { open } = await api('/api/admin/registration');
  el.innerHTML = `
    <div class="settings-list-group" style="padding:14px; display:flex; flex-direction:column; gap:6px;">
      <div style="font-weight:600;">Регистрация новых пользователей: ${open ? '🟢 открыта' : '🔴 закрыта'}</div>
      <div class="chat-header-sub" style="padding:0;">Пока регистрация закрыта, новые аккаунты создать нельзя — ни через сайт, ни через приложение. Уже существующие пользователи входят как обычно.</div>
      <button class="${open ? 'btn-danger' : 'btn-primary'}" id="registrationToggleBtn" style="margin-top:6px;">${open ? 'Закрыть регистрацию' : 'Открыть регистрацию'}</button>
    </div>
  `;
  $('#registrationToggleBtn').addEventListener('click', async () => {
    await api('/api/admin/registration', { method: 'POST', body: { open: !open } });
    renderAdminRegistration();
  });
}

/* ---------------- АДМИН: баннер на главной странице ---------------- */

async function renderAdminBanner() {
  const el = $('#adminBannerTab');
  const { banner } = await api('/api/admin/banner');

  el.innerHTML = `
    ${banner ? `
      <div class="admin-apk-current">
        <div class="admin-apk-current-title">Текущий баннер (${banner.enabled ? 'включён' : 'выключен'}):</div>
        <div class="admin-apk-current-row">
          <div>
            <b>${escapeHtml(banner.title)}</b>
            ${banner.description ? `<div class="admin-apk-notes">${escapeHtml(banner.description)}</div>` : ''}
            <div class="admin-msg-meta">Обновлено ${fmtDate(banner.updatedAt)} · ${escapeHtml(banner.updatedBy || '')}</div>
          </div>
          <div style="display:flex; gap:8px; flex-shrink:0;">
            <button class="btn-secondary" id="bannerToggleBtn">${banner.enabled ? 'Выключить' : 'Включить'}</button>
            <button class="btn-secondary" id="bannerDeleteBtn">Удалить</button>
          </div>
        </div>
      </div>
    ` : `<div class="admin-msg-meta">Баннер ещё не создан — пользователи ничего не увидят, пока вы его не сохраните.</div>`}

    <div class="admin-apk-upload-form">
      <div class="admin-apk-current-title">${banner ? 'Изменить и сохранить заново' : 'Создать баннер'}</div>
      <label class="field-label">Картинка (маленькая, скруглённая, слева от текста)</label>
      <input type="file" id="bannerImageInput" accept="image/*">
      <label class="field-label">Заголовок</label>
      <input type="text" id="bannerTitle" maxlength="120" value="${banner ? escapeHtml(banner.title) : ''}" placeholder="Например: Мы обновились!">
      <label class="field-label">Описание</label>
      <textarea id="bannerDescription" rows="2" maxlength="300" placeholder="Коротко, в пару предложений">${banner ? escapeHtml(banner.description || '') : ''}</textarea>
      <button class="btn-primary" id="bannerSaveBtn">Сохранить и опубликовать</button>
      <div class="admin-msg-meta" id="bannerSaveStatus"></div>
    </div>
  `;

  if (banner) {
    $('#bannerToggleBtn').addEventListener('click', async () => {
      await api('/api/admin/banner/toggle', { method: 'POST' });
      renderAdminBanner();
    });
    $('#bannerDeleteBtn').addEventListener('click', async () => {
      if (!confirm('Удалить баннер вместе с картинкой? Пользователи, у которых он сейчас открыт, перестанут его видеть.')) return;
      await api('/api/admin/banner', { method: 'DELETE' });
      renderAdminBanner();
    });
  }

  $('#bannerSaveBtn').addEventListener('click', async () => {
    const title = $('#bannerTitle').value.trim();
    const description = $('#bannerDescription').value.trim();
    const file = $('#bannerImageInput').files[0];
    const statusEl = $('#bannerSaveStatus');

    if (!title) { statusEl.textContent = 'Укажите заголовок'; return; }

    const btn = $('#bannerSaveBtn');
    btn.disabled = true;
    statusEl.textContent = file ? 'Загружаю картинку…' : 'Сохраняю…';
    try {
      let imageUrl = banner ? banner.imageUrl : null;
      if (file) imageUrl = await uploadFile(file, 'image');
      await api('/api/admin/banner', { method: 'POST', body: { title, description, imageUrl, enabled: true } });
      statusEl.textContent = '✅ Баннер опубликован и появится у всех пользователей.';
      renderAdminBanner();
    } catch (e) {
      statusEl.textContent = '❌ ' + (e.message || 'Не удалось сохранить баннер');
    } finally {
      btn.disabled = false;
    }
  });
}

/* ---------------- INIT ---------------- */
checkSession();



// ======================================================================
// Жесты в чате:
//  • свайп сообщения справа налево  → «Ответить»
//  • свайп вправо по открытому чату → выход из чата к списку (мобильный)
// Направление фиксируется по первым ~10px движения, поэтому вертикальная
// прокрутка ленты и горизонтальная прокрутка внутри сообщений не страдают.
// ======================================================================
(function initChatSwipes() {
  const messagesEl = document.getElementById('messages');
  const chatActive = document.getElementById('chatActive');
  const chatPanel = document.getElementById('chatPanel');
  if (!messagesEl || !chatActive || !chatPanel) return;

  const REPLY_TRIGGER = 64;   // px до срабатывания «ответить»
  const REPLY_MAX = 96;       // максимальный сдвиг пузыря
  const EXIT_RATIO = 0.32;    // доля ширины экрана для выхода
  const LOCK_PX = 10;

  const IGNORE = 'input, textarea, select, audio, video, canvas, a, button, [contenteditable], .poll-option, .composer, .emoji-panel, .sticker-panel, .reaction-pill';

  function inHorizontalScroller(el, stop) {
    while (el && el !== stop && el.nodeType === 1) {
      const cs = getComputedStyle(el);
      if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 2) return true;
      el = el.parentElement;
    }
    return false;
  }
  function overlayOpen() {
    return !!document.querySelector('.modal:not(.hidden), .lightbox:not(.hidden), .story-fs:not(.hidden), .msg-context-overlay:not(.hidden)');
  }
  function buzz() { try { navigator.vibrate && navigator.vibrate(12); } catch (_) {} }

  let g = null; // состояние текущего жеста

  chatActive.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || overlayOpen()) { g = null; return; }
    const t = e.touches[0];
    const target = e.target;
    g = {
      x: t.clientX, y: t.clientY, dx: 0, mode: null, lastX: t.clientX, lastT: Date.now(), v: 0,
      row: target.closest ? target.closest('.msg-row') : null,
      blocked: !!(target.closest && target.closest(IGNORE)) || inHorizontalScroller(target, chatActive),
      icon: null, armed: false,
    };
  }, { passive: true });

  chatActive.addEventListener('touchmove', (e) => {
    if (!g || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - g.x, dy = t.clientY - g.y;

    if (!g.mode) {
      if (Math.abs(dx) < LOCK_PX && Math.abs(dy) < LOCK_PX) return;
      if (Math.abs(dy) > Math.abs(dx) * 0.8) { g = null; return; }           // вертикальный скролл
      if (dx < 0 && g.row && !g.blocked && canReplyBySwipe(g.row)) {
        g.mode = 'reply';
        g.row.classList.add('swiping');
        g.row.classList.remove('swipe-release');
        // Новый дизайн: стеклянная кнопка с векторной стрелкой «ответить» и
        // кольцом прогресса, которое заполняется по мере протягивания.
        g.icon = document.createElement('div');
        g.icon.className = 'swipe-reply-icon';
        g.icon.innerHTML =
          '<svg class="swipe-ring" viewBox="0 0 40 40" aria-hidden="true">' +
            '<circle class="ring-bg" cx="20" cy="20" r="17"></circle>' +
            '<circle class="ring-fg" cx="20" cy="20" r="17"></circle>' +
          '</svg>' +
          '<svg class="swipe-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" fill="currentColor"/></svg>';
        g.ring = g.icon.querySelector('.ring-fg');
        g.row.appendChild(g.icon);
      } else if (dx > 0 && isMobile() && !g.blocked && state.activeConvId) {
        g.mode = 'exit';
        chatPanel.classList.add('swipe-dragging');
        const sb = document.querySelector('#sectionChats .sidebar');
        if (sb) g.sidebar = sb;
      } else { g = null; return; }
    }

    const now = Date.now();
    g.v = (t.clientX - g.lastX) / Math.max(1, now - g.lastT);
    g.lastX = t.clientX; g.lastT = now;

    if (g.mode === 'reply') {
      // до порога пузырь идёт ровно за пальцем (порог достигается на REPLY_TRIGGER px
      // движения — раньше степенная кривая требовала вести палец ~125px),
      // дальше — «резиновое» сопротивление до REPLY_MAX
      const pulled = -Math.min(0, dx);
      const eased = pulled <= REPLY_TRIGGER ? pulled : REPLY_TRIGGER + (pulled - REPLY_TRIGGER) * 0.35;
      const shift = -Math.min(REPLY_MAX, eased);
      g.dx = shift;
      const bubble = g.row.querySelector('.bubble');
      if (bubble) bubble.style.transform = `translateX(${shift}px)`;
      const p = Math.min(1, -shift / REPLY_TRIGGER);
      const armed = -shift >= REPLY_TRIGGER;
      // кнопка выезжает из-за края вслед за пузырём и «растёт»; кольцо
      // показывает, сколько осталось до срабатывания
      g.icon.style.opacity = String(Math.min(1, p * 1.4));
      g.icon.style.transform = `translateX(${(1 - p) * 22}px) scale(${armed ? 1.12 : 0.55 + 0.45 * p})`;
      if (g.ring) g.ring.style.strokeDashoffset = String(106.8 * (1 - p));
      if (armed !== g.armed) {
        g.armed = armed;
        g.icon.classList.toggle('armed', armed);
        if (armed) buzz();
      }
      if (e.cancelable) e.preventDefault();
    } else if (g.mode === 'exit') {
      const w = chatPanel.clientWidth || window.innerWidth;
      g.dx = Math.max(0, Math.min(w, dx));
      chatPanel.style.transform = `translateX(${g.dx}px)`;
      if (g.sidebar) { g.sidebar.style.transition = 'none'; g.sidebar.style.transform = `translateX(${-w + g.dx}px)`; }
      if (e.cancelable) e.preventDefault();
    }
  }, { passive: false });

  function finish(cancelled) {
    if (!g) return;
    const s = g; g = null;
    if (s.mode === 'reply') {
      const bubble = s.row.querySelector('.bubble');
      s.row.classList.remove('swiping');
      s.row.classList.add('swipe-release');
      if (bubble) bubble.style.transform = '';
      if (s.icon) {
        s.icon.classList.add('release');
        if (!cancelled && s.armed) {
          // сработало: кнопка коротко «вспыхивает» и улетает влево к композеру
          s.icon.classList.add('fired');
          s.icon.style.opacity = '0';
          s.icon.style.transform = 'translateX(-14px) scale(1.35)';
        } else {
          s.icon.style.opacity = '0';
          s.icon.style.transform = 'translateX(22px) scale(.55)';
        }
        setTimeout(() => s.icon && s.icon.remove(), 400);
      }
      setTimeout(() => s.row.classList.remove('swipe-release'), 420);
      if (!cancelled && s.armed) {
        const list = state.messages[state.activeConvId] || [];
        const m = list.find((x) => String(x.id) === String(s.row.dataset.msgId));
        if (m) startReply(m);
      }
    } else if (s.mode === 'exit') {
      const w = chatPanel.clientWidth || window.innerWidth;
      const commit = !cancelled && (s.dx > w * EXIT_RATIO || (s.v > 0.5 && s.dx > 40));
      // возвращаем CSS-transition и фиксируем текущую позицию, чтобы анимация шла от пальца
      chatPanel.classList.remove('swipe-dragging');
      if (s.sidebar) s.sidebar.style.transition = '';
      void chatPanel.offsetWidth;
      chatPanel.style.transform = '';
      if (s.sidebar) s.sidebar.style.transform = '';
      if (commit) {
        const back = document.getElementById('backToListBtn');
        if (back) back.click();
      }
    }
  }
  chatActive.addEventListener('touchend', () => finish(false), { passive: true });
  chatActive.addEventListener('touchcancel', () => finish(true), { passive: true });

  function canReplyBySwipe(row) {
    if (!row || row.classList.contains('msg-deleted')) return false;
    const conv = state.conversations.find((c) => c.id === state.activeConvId);
    if (!conv) return false;
    const composer = document.getElementById('composer');
    if (composer && composer.classList.contains('hidden')) return false;
    return canPostInConv(conv);
  }
})();
