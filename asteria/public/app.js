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
const REACTIONS = ['👍','👎','❤️','😂','😮','😢','🔥'];

// ---------- Asteria Premium ----------
// Цена указывается только информационно — оформить подписку можно
// исключительно через администратора (кнопка в админ-панели).
const PREMIUM_PRICE_LABEL = '199 ₽/мес';
// Анимированные emoji-реакции — доступны только по подписке. Сервер это тоже
// проверяет (см. server.js), клиентская блокировка — просто для UX.
const PREMIUM_REACTIONS = ['🤩','🥳','💯','⚡','🌟','😍'];
// Эксклюзивные темы оформления (см. PREMIUM_ONLY_THEMES на сервере)
const PREMIUM_THEME_VALUES = new Set(['aurora', 'gold']);
// Бесплатные готовые фоны чата — доступны всем пользователям без подписки.
const FREE_WALLPAPERS = [
  { id: 'tattoo', label: 'Тату', css: "url('/wallpapers/free-tattoo.webp')" },
  { id: 'doodle-blue', label: 'Смайлы', css: "url('/wallpapers/free-doodle-blue.jpeg')" },
  { id: 'space', label: 'Космос', css: "url('/wallpapers/free-space.jpeg')" },
  { id: 'pets-pink', label: 'Питомцы', css: "url('/wallpapers/free-pets-pink.jpeg')" },
];

function isPremiumActive(u) {
  if (!u || !u.isPremium) return false;
  if (!u.premiumUntil) return true;
  return u.premiumUntil > Date.now();
}

function $(sel) { return document.querySelector(sel); }
function showModal(sel) { const el = typeof sel === 'string' ? $(sel) : sel; if (el) { document.body.appendChild(el); el.classList.remove('hidden'); } return el; }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка запроса');
  return data;
}

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
function verifiedBadge(u) {
  if (!u || !u.isVerified) return '';
  return '<span class="verified-badge" title="Аккаунт подтверждён администратором">'
    + '<svg viewBox="0 0 100 100" width="14" height="14" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
    + '<circle cx="50" cy="50" r="48" fill="#1f9be0"/>'
    + '<path d="M 29 50 L 43 64 L 75 32" fill="none" stroke="#fff" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg></span>';
}

// Золотая звезда у имени Premium-подписчиков — рисуется везде рядом с
// verifiedBadge(). Выдаётся только администратором из админ-панели.
function premiumBadge(u) {
  return u && isPremiumActive(u) ? '<span class="premium-badge" title="Asteria Premium">⭐</span>' : '';
}

// Золотое кольцо вокруг аватара Premium-пользователя отключено по решению
// продукта — для Premium теперь достаточно золотого значка (premiumBadge)
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

const AUTH_STEP_IDS = ['start', 'login1', 'login2', 'reg1', 'reg2', 'reg3'];
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
$('#authGoRegister').addEventListener('click', () => {
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
    const link = `${location.origin}/qr/${id}`;
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
  const subpages = ['profile', 'channel'];
  if (subpages.includes(name) && !subpages.includes(previous)) state.subpageReturnSection = previous || 'chats';
  state.activeSection = name;

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
    ['chats', 'calls', 'settings', 'admin', 'profile', 'channel'].forEach((s) => {
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

  // Клик, которым закончился перетаскивание (а не обычный тап), нужно один
  // раз погасить — переключение раздела уже произошло в finishDrag().
  nav.addEventListener('click', (e) => {
    if (!suppressNextClick) return;
    suppressNextClick = false;
    if (e.target.closest('.bottom-nav-btn')) { e.stopPropagation(); e.preventDefault(); }
  }, true);
})();

window.addEventListener('resize', () => { equalizeBottomNavButtonWidths(); moveBottomNavIndicator(state.activeSection || 'chats', false); });

$all('.nav-rail-btn[data-section]').forEach((btn) => btn.addEventListener('click', () => switchSection(btn.dataset.section)));
$all('.bottom-nav-btn[data-section]').forEach((btn) => btn.addEventListener('click', () => switchSection(btn.dataset.section)));
$('#myAvatar').addEventListener('click', () => switchSection('settings'));
$('#adminBackBtn').addEventListener('click', () => switchSection('chats'));
$('#profileBackBtn').addEventListener('click', () => switchSection(state.subpageReturnSection || 'chats'));
$('#channelBackBtn').addEventListener('click', () => switchSection(state.subpageReturnSection || 'chats'));
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
  ws.addEventListener('close', () => { setTimeout(connectWS, 2000); });
}

function handleWSEvent(msg) {
  if (msg.type === 'message') {
    const convId = msg.message.conversationId;
    if (!state.messages[convId]) state.messages[convId] = [];
    state.messages[convId].push(msg.message);
    bumpConversation(convId, msg.message);
    if (state.activeConvId === convId) { appendMessageBubble(msg.message); markConversationRead(convId); }
    else renderConvList();
    notifyNewMessage(msg.message);
  } else if (msg.type === 'read-update') {
    const conv = state.conversations.find((c) => c.id === msg.conversationId);
    if (conv) {
      conv.reads = { ...(conv.reads || {}), [msg.userId]: msg.at };
      if (state.activeConvId === msg.conversationId) renderMessages();
    }
  } else if (msg.type === 'message-edit') {
    const convId = msg.message.conversationId;
    const list = state.messages[convId];
    if (list) {
      const idx = list.findIndex((m) => m.id === msg.message.id);
      if (idx !== -1) list[idx] = msg.message;
    }
    if (state.activeConvId === convId) renderMessages();
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
  } else if (msg.type === 'reaction-update') {
    const list = state.messages[msg.conversationId];
    if (list) {
      const m = list.find((mm) => mm.id === msg.messageId);
      if (m) m.reactions = msg.reactions;
    }
    if (state.activeConvId === msg.conversationId) renderMessages();
  } else if (msg.type === 'poll-update') {
    const list = state.messages[msg.conversationId];
    if (list) {
      const m = list.find((mm) => mm.id === msg.messageId);
      if (m && m.meta) m.meta = { ...m.meta, votes: msg.votes };
    }
    if (state.activeConvId === msg.conversationId) renderMessages();
  } else if (msg.type === 'conversation-updated') {
    mergeConversation(msg.conversation);
  } else if (msg.type === 'conversation-deleted') {
    state.conversations = state.conversations.filter((c) => c.id !== msg.conversationId);
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
  const nameBadge = conv.type === 'dm' ? verifiedBadge(conv.peer) + premiumBadge(conv.peer) : verifiedBadge(conv);
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
  const map = { text: m.content, image: '📷 Фото', video: '🎬 Видео', file: '📄 Файл', music: '🎵 Музыка', voice: '🎙 Голосовое', video_circle: '⭕ Видео-сообщение', sticker: '😊 Стикер', poll: '📊 Опрос', location: '📍 Геолокация', album: '🖼 Альбом' };
  const base = map[m.msgType] || m.content || '';
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
  if (!state.messages[convId]) {
    // Открытие чата подгружает только "хвост" переписки (последние 40
    // сообщений), а не всю историю целиком — раньше именно полная выгрузка
    // (плюс мгновенный автозапуск всех видео-превью в ней) была причиной
    // долгой (до нескольких секунд, особенно на слабом сервере) загрузки
    // при открытии чатов с большой историей. Более старые сообщения
    // подгружаются лениво по мере прокрутки вверх — см. слушатель scroll
    // на #messages и loadOlderMessages() ниже.
    const { messages, hasMore } = await api(`/api/conversations/${convId}/messages?limit=${MESSAGES_PAGE_SIZE}`);
    state.messages[convId] = messages;
    state.messagesHasMore[convId] = !!hasMore;
  }
  renderMessages();
  markConversationRead(convId);
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
}

$('#backToListBtn').addEventListener('click', () => {
  $('#sectionChats').classList.remove('chat-open');
  $('#appScreen').classList.remove('chat-open');
  moveBottomNavIndicator(state.activeSection || 'chats', false);
});

function canPostInConv(conv) {
  if (!conv) return false;
  if (conv.type === 'dm' || conv.type === 'group') return true;
  return conv.ownerId === state.user.id || !!state.user.isAdmin;
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
  const badge = conv.type === 'dm' ? verifiedBadge(conv.peer) + premiumBadge(conv.peer) : verifiedBadge(conv);
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
  if (conv.type === 'channel') return conv.ownerId === state.user.id || state.user.isAdmin;
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

async function openProfilePage(userId) {
  const { user } = await api(`/api/users/${userId}`);
  const el = $('#profileViewContent');
  el.innerHTML = `
    <div class="profile-hero">
      <div class="my-avatar big xl${avatarRingClass(user)}" style="${avatarStyle(user)}">${user.avatar ? '' : initials(user.displayName)}</div>
      <div class="profile-hero-name">${escapeHtml(user.displayName)}${verifiedBadge(user)}${premiumBadge(user)}${user.isBot ? ' 🤖' : ''}</div>
      <div class="profile-hero-username">@${escapeHtml(user.username)}</div>
    </div>
    <div class="settings-list-group settings-info-group">
      <div class="settings-info-row">
        <div class="grow">
          <div class="sir-label">имя пользователя</div>
          <div class="sir-value">@${escapeHtml(user.username)}</div>
        </div>
        ${!user.isBot ? `<button class="icon-btn" id="otherProfileQrBtn" title="Показать QR-код">▦</button>` : ''}
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
    ${!user.isBot ? `<button class="btn-secondary" id="profileShareBtn">Поделиться профилем</button>` : ''}
    <div class="profile-media-section" id="profileMediaSection"></div>
  `;
  switchSection('profile');
  const heroAvatar = el.querySelector('.profile-hero .my-avatar');
  if (heroAvatar && user.avatar) {
    heroAvatar.classList.add('avatar-clickable');
    heroAvatar.title = 'Открыть фото профиля';
    heroAvatar.addEventListener('click', () => openAvatarLightbox(user.avatar));
  }
  const shareBtn = $('#profileShareBtn');
  if (shareBtn) shareBtn.addEventListener('click', () => openShareModal(user.displayName, buildProfileLink(user.username)));
  const qrBtn = $('#otherProfileQrBtn');
  if (qrBtn) qrBtn.addEventListener('click', () => openShareModal(user.displayName, buildProfileLink(user.username)));
  if (!user.isBot) loadProfileMediaSection(user);
}

// Общие медиа/файлы/ссылки с этим человеком — как в Telegram, отдельные
// вкладки внизу профиля. Ботам не показываем (у них обычно нет личной
// переписки в привычном смысле).
async function loadProfileMediaSection(user) {
  const section = $('#profileMediaSection');
  if (!section) return;
  section.innerHTML = `<div class="profile-media-loading">Загрузка медиа…</div>`;
  let conv;
  try {
    ({ conversation: conv } = await api('/api/conversations', { method: 'POST', body: { type: 'dm', userId: user.id } }));
  } catch (e) {
    section.innerHTML = '';
    return;
  }
  // На всякий случай проверяем, что пользователь не успел уйти со страницы
  // профиля этого человека, пока грузилась история (например, открыл
  // профиль другого контакта) — тогда просто ничего не подставляем.
  if (!document.body.contains(section)) return;

  const messages = await fetchAllMessagesForProfileMedia(conv.id);
  if (!document.body.contains(section)) return;

  const media = []; // { url, type, createdAt }
  const files = []; // { url, name, createdAt }
  const links = []; // { url, createdAt }
  const linkRe = /(https?:\/\/[^\s<>"']{4,600})/g;

  messages.forEach((m) => {
    if (m.msgType === 'image' || m.msgType === 'video') {
      media.push({ url: m.mediaUrl, type: m.msgType, createdAt: m.createdAt });
    } else if (m.msgType === 'album' && m.meta && Array.isArray(m.meta.items)) {
      m.meta.items.forEach((it) => media.push({ url: it.url, type: it.kind === 'video' ? 'video' : 'image', createdAt: m.createdAt }));
    } else if (m.msgType === 'file') {
      files.push({ url: m.mediaUrl, name: (m.meta && m.meta.name) || 'Файл', createdAt: m.createdAt });
    }
    if (m.msgType === 'text' && m.content) {
      const found = m.content.match(linkRe);
      if (found) found.forEach((url) => links.push({ url, createdAt: m.createdAt }));
    }
  });
  media.sort((a, b) => b.createdAt - a.createdAt);
  files.sort((a, b) => b.createdAt - a.createdAt);
  links.sort((a, b) => b.createdAt - a.createdAt);

  renderProfileMediaSection(section, { media, files, links });
}

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
  { key: 'media', label: 'Медиа' },
  { key: 'files', label: 'Файлы' },
  { key: 'links', label: 'Ссылки' },
];
function renderProfileMediaSection(section, data) {
  const counts = { media: data.media.length, files: data.files.length, links: data.links.length };
  const available = PROFILE_MEDIA_TABS.filter((t) => counts[t.key] > 0);
  if (!available.length) { section.innerHTML = ''; return; }
  let active = available[0].key;

  function renderTabs() {
    return `<div class="profile-media-tabs">${available.map((t) =>
      `<button type="button" class="profile-media-tab${t.key === active ? ' active' : ''}" data-tab="${t.key}">${t.label} <span class="profile-media-tab-count">${counts[t.key]}</span></button>`
    ).join('')}</div>`;
  }

  function renderBody() {
    if (active === 'media') {
      return `<div class="profile-media-grid">${data.media.map((it, idx) =>
        `<div class="profile-media-tile" data-idx="${idx}" data-type="${it.type}">
          ${it.type === 'video' ? `<video src="${it.url}" muted playsinline preload="metadata"></video><span class="album-video-badge">▶</span>` : `<img src="${it.url}" loading="lazy">`}
        </div>`
      ).join('')}</div>`;
    }
    if (active === 'files') {
      return `<div class="profile-files-list">${data.files.map((f) =>
        `<a class="profile-file-row" href="${f.url}" target="_blank" rel="noopener noreferrer">
          <span class="profile-file-icon">📄</span>
          <span class="grow">
            <span class="profile-file-name">${escapeHtml(f.name)}</span>
            <span class="profile-file-date">${fmtDate(f.createdAt)}</span>
          </span>
        </a>`
      ).join('')}</div>`;
    }
    return `<div class="profile-links-list">${data.links.map((l) =>
      `<a class="profile-link-row" href="${l.url}" target="_blank" rel="noopener noreferrer nofollow">
        <span class="profile-file-icon">🔗</span>
        <span class="grow">
          <span class="profile-link-url">${escapeHtml(l.url)}</span>
          <span class="profile-file-date">${fmtDate(l.createdAt)}</span>
        </span>
      </a>`
    ).join('')}</div>`;
  }

  function render() {
    section.innerHTML = renderTabs() + `<div class="profile-media-body">${renderBody()}</div>`;
    section.querySelectorAll('.profile-media-tab').forEach((btn) => {
      btn.addEventListener('click', () => { active = btn.dataset.tab; render(); });
    });
    if (active === 'media') {
      section.querySelectorAll('.profile-media-tile').forEach((tile) => {
        tile.addEventListener('click', () => {
          const idx = Number(tile.dataset.idx);
          openProfileMediaLightbox(data.media, idx);
        });
      });
    }
  }
  render();
}

// Отдельный от обычного лайтбокса чата список (см. openLightbox выше) —
// здесь листаем именно общие медиа с этим человеком, а не сообщения
// текущего открытого чата (профиль можно открыть, даже не заходя в чат).
function openProfileMediaLightbox(media, startIdx) {
  lightboxState.list = media.map((it) => ({ url: it.url, type: it.type, msgId: null, itemIdx: null }));
  showLightboxAt(startIdx);
}

/* ---------------- CHANNEL PAGE ---------------- */

let channelEditAvatarUrl = '';

async function openChannelPage(convId) {
  const conv = state.conversations.find((c) => c.id === convId);
  if (!conv) return;
  const isOwner = conv.ownerId === state.user.id;
  const isAdmin = !!state.user.isAdmin;
  const isGroup = conv.type === 'group';
  const el = $('#channelViewContent');
  channelEditAvatarUrl = conv.avatar || '';
  $('#channelModalTitle').textContent = isGroup ? 'Группа' : 'Канал';

  const memberWord = isGroup ? 'участников' : 'подписчиков';
  const postingNote = isGroup ? '· писать могут все участники' : '· писать может только владелец';
  // Дизайн страницы канала/группы — как у обычного профиля пользователя
  // (openProfilePage выше): по центру большой аватар + имя, ниже —
  // карточка с информацией (.settings-info-group), а не старый левосторонний
  // .channel-info-row. Описание — такое же поле, как "о себе" у профиля.
  let html = `
    <div class="profile-hero">
      <div class="my-avatar big xl" id="channelInfoAvatar" style="${avatarStyle(conv)}">${conv.avatar ? '' : initials(conv.name)}</div>
      <div class="profile-hero-name">${escapeHtml(conv.name)}${verifiedBadge(conv)}</div>
      <div class="profile-hero-username">${(conv.participants||[]).length} ${memberWord} ${postingNote}</div>
    </div>
    <div class="settings-list-group settings-info-group">
      <div class="settings-info-row">
        <div class="grow">
          <div class="sir-label">описание</div>
          <div class="sir-value" id="channelInfoDescription">${conv.description ? escapeHtml(conv.description).replace(/\n/g, '<br>') : '—'}</div>
        </div>
      </div>
      <div class="settings-info-row">
        <div class="grow">
          <div class="sir-label">тип</div>
          <div class="sir-value">${isGroup ? 'Группа' : 'Канал'}</div>
        </div>
      </div>
    </div>`;

  if (conv.inviteCode) {
    const link = buildInviteLink(conv.inviteCode);
    html += `
      <div class="modal-subtitle">Пригласительная ссылка</div>
      <div class="compose-invite-link">${escapeHtml(link)}</div>
      <div class="settings-avatar-actions" style="flex-direction:row;">
        <button class="btn-secondary" id="channelCopyInviteBtn">Скопировать</button>
        <button class="btn-secondary" id="channelShareInviteBtn">Поделиться</button>
      </div>
      ${isOwner || isAdmin ? `<input type="text" id="channelEditInviteCode" value="${escapeHtml(conv.inviteCode)}" placeholder="Код ссылки">` : ''}`;
  }

  if (isOwner || isAdmin) {
    html += `
      <div class="channel-edit-fields">
        <div class="settings-avatar-actions" style="flex-direction:row;">
          <button class="btn-secondary" id="channelChangeAvatarBtn">Изменить фото</button>
          <button class="btn-danger" id="channelRemoveAvatarBtn">Удалить фото</button>
          <input type="file" id="channelAvatarInput" accept="image/*" class="hidden">
        </div>
        <input type="text" id="channelEditName" value="${escapeHtml(conv.name)}" placeholder="${isGroup ? 'Название группы' : 'Название канала'}">
        <textarea id="channelEditDescription" placeholder="${isGroup ? 'Описание группы (необязательно)' : 'Описание канала (необязательно)'}" maxlength="500">${escapeHtml(conv.description || '')}</textarea>
        ${isGroup ? `<label class="checkbox-row"><input type="checkbox" id="channelEditGroupCalls" ${conv.groupCallsEnabled !== false ? 'checked' : ''}> Разрешить групповые звонки</label>` : ''}
        <button class="btn-primary" id="channelSaveBtn">Сохранить изменения</button>
      </div>
      <div class="channel-actions">
        <button class="btn-danger" id="channelDeleteBtn">${isGroup ? 'Удалить группу' : 'Удалить канал'}</button>
      </div>`;
  } else {
    const subscribed = isSubscribedTo(conv);
    const label = isGroup ? (subscribed ? '✓ Вы в группе — покинуть' : 'Вступить') : (subscribed ? '✓ Вы подписаны — отписаться' : 'Подписаться');
    html += `<div class="channel-actions">
      <button class="btn-secondary" id="channelSubToggleBtn">${label}</button>
    </div>`;
  }

  el.innerHTML = html;
  switchSection('channel');
  const infoAvatar = $('#channelInfoAvatar');
  if (infoAvatar && conv.avatar) {
    infoAvatar.classList.add('avatar-clickable');
    infoAvatar.title = 'Открыть фото профиля';
    infoAvatar.addEventListener('click', () => openAvatarLightbox(conv.avatar));
  }

  const copyInviteBtn = $('#channelCopyInviteBtn');
  if (copyInviteBtn) copyInviteBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(buildInviteLink(conv.inviteCode));
    copyInviteBtn.textContent = 'Скопировано!';
    setTimeout(() => { copyInviteBtn.textContent = 'Скопировать'; }, 1500);
  });
  const shareInviteBtn = $('#channelShareInviteBtn');
  if (shareInviteBtn) shareInviteBtn.addEventListener('click', () => openShareModal(conv.name, buildInviteLink(conv.inviteCode)));

  const changeAvBtn = $('#channelChangeAvatarBtn');
  if (changeAvBtn) changeAvBtn.addEventListener('click', () => $('#channelAvatarInput').click());
  const avInput = $('#channelAvatarInput');
  if (avInput) avInput.addEventListener('change', async () => {
    const file = avInput.files[0];
    if (!file) return;
    channelEditAvatarUrl = await uploadFile(file, 'avatar');
    const prev = $('#channelInfoAvatar');
    prev.style.cssText = `background-image:url('${channelEditAvatarUrl}')`;
    prev.textContent = '';
  });
  const removeAvBtn = $('#channelRemoveAvatarBtn');
  if (removeAvBtn) removeAvBtn.addEventListener('click', () => {
    channelEditAvatarUrl = '';
    const prev = $('#channelInfoAvatar');
    prev.style.cssText = '';
    prev.textContent = initials(conv.name);
  });

  const saveBtn = $('#channelSaveBtn');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const name = $('#channelEditName').value.trim();
    const descEl = $('#channelEditDescription');
    const description = descEl ? descEl.value.trim() : undefined;
    const groupCallsCheckbox = $('#channelEditGroupCalls');
    const groupCallsEnabled = groupCallsCheckbox ? groupCallsCheckbox.checked : undefined;
    if (!name) return;
    const inviteEl = $('#channelEditInviteCode');
    const patchBody = { name, avatar: channelEditAvatarUrl };
    if (description !== undefined) patchBody.description = description;
    if (groupCallsEnabled !== undefined) patchBody.groupCallsEnabled = groupCallsEnabled;
    if (inviteEl && inviteEl.value.trim()) patchBody.inviteCode = inviteEl.value.trim();
    let conversation;
    try {
      ({ conversation } = await api(`/api/conversations/${convId}`, { method: 'PATCH', body: patchBody }));
    } catch (e) { alert(e.message || 'Не удалось сохранить'); return; }
    mergeConversation(conversation);
    switchSection(state.subpageReturnSection || 'chats');
  });
  const delBtn = $('#channelDeleteBtn');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!confirm(`${isGroup ? 'Удалить группу' : 'Удалить канал'} «${conv.name}» безвозвратно?`)) return;
    await api(`/api/conversations/${convId}`, { method: 'DELETE' });
    state.conversations = state.conversations.filter((c) => c.id !== convId);
    switchSection(state.subpageReturnSection || 'chats');
    closeActiveChat();
  });
  const subBtn = $('#channelSubToggleBtn');
  if (subBtn) subBtn.addEventListener('click', async () => {
    if (isSubscribedTo(conv)) {
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
  });
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
  el.innerHTML = '';
  const list = state.messages[state.activeConvId] || [];
  el.classList.toggle('is-empty', list.length === 0);
  if (list.length === 0) {
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
  }
  if (!preserveScroll) el.scrollTop = el.scrollHeight;
  updateChatFogState();
  updateComposerVisibility(state.conversations.find((c) => c.id === state.activeConvId));
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
  if (!lastSeparator || lastSeparator.dataset.dayKey !== dayKey) {
    const sep = renderDateSeparator(m.createdAt);
    sep.classList.add('msg-enter');
    el.appendChild(sep);
  }
  const row = renderMessageBubble(m);
  row.classList.add('msg-enter');
  el.appendChild(row);
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
  const senderName = m.senderId === state.user.id ? '' : `<div class="sender">${escapeHtml(senderLabel(m.senderId))}${verifiedBadge(findKnownUser(m.senderId))}${premiumBadge(findKnownUser(m.senderId))}</div>`;
  if (m.senderId !== state.user.id && !senderIsKnown(m.senderId)) {
    ensureUserCached(m.senderId).then((u) => {
      if (!u) return;
      const el = row.querySelector('.sender');
      if (el) el.innerHTML = escapeHtml(u.displayName) + verifiedBadge(u) + premiumBadge(u);
    });
  }
  let replyBlock = '';
  if (m.replyPreview) {
    const rp = m.replyPreview;
    replyBlock = `<div class="reply-quote" data-reply-to="${rp.id}"><div class="reply-quote-name">${escapeHtml(rp.senderName)}</div><div class="reply-quote-text">${escapeHtml(replyPreviewLabel(rp))}</div></div>`;
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
  else if (m.msgType === 'music') inner = `<div>🎵 ${escapeHtml((m.meta && m.meta.name) || 'Трек')}</div><audio src="${m.mediaUrl}" controls></audio>`;
  else if (m.msgType === 'file') inner = `<a class="file-chip" href="${m.mediaUrl}" target="_blank" style="color:inherit;text-decoration:none;">📄 ${escapeHtml((m.meta && m.meta.name) || 'Файл')}</a>`;
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
      rr.appendChild(pill);
    });
    bubble.appendChild(rr);
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
  const finish = () => { if (done) return; done = true; circleAutoScrollDepth--; };
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
    if (bubble._circlePlaceholder) { bubble._circlePlaceholder.remove(); bubble._circlePlaceholder = null; }
    // Если при разворачивании мы искусственно проскроллили ленту вниз
    // (см. isLastRow-ветку в expand()), теперь откатываем это обратно —
    // сообщения "до" плавно возвращаются на своё место.
    if (bubble._circleScrollDelta) {
      animateMessagesScroll(messagesEl, -bubble._circleScrollDelta, 250);
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
  if (isMine && m.msgType === 'text') {
    const editBtn = document.createElement('button');
    editBtn.textContent = '✏️ Изменить';
    editBtn.addEventListener('click', () => { closeMsgContextMenu(); startEditMessage(row, m); });
    actionsEl.appendChild(editBtn);
  }
  if (isMine || state.user.isAdmin) {
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

function sendReaction(messageId, emoji) {
  if (!state.ws || state.ws.readyState !== 1) return;
  state.ws.send(JSON.stringify({ type: 'reaction', messageId, emoji }));
  $('#reactionPicker').classList.add('hidden');
}

// Рисует стандартные + эксклюзивные анимированные Premium-реакции.
// Premium-реакции для остальных пользователей показываются с 🔒 —
// клик по ним объясняет, что нужна подписка (сервер это тоже проверяет).
function renderReactionButtons(container, messageId, afterClick) {
  const premium = isPremiumActive(state.user);
  REACTIONS.forEach((emoji) => {
    const b = document.createElement('button');
    b.textContent = emoji;
    b.addEventListener('click', () => { sendReaction(messageId, emoji); if (afterClick) afterClick(); });
    container.appendChild(b);
  });
  const divider = document.createElement('span');
  divider.className = 'reaction-picker-divider';
  container.appendChild(divider);
  PREMIUM_REACTIONS.forEach((emoji) => {
    const b = document.createElement('button');
    b.className = 'reaction-premium' + (premium ? '' : ' locked');
    b.textContent = emoji;
    b.title = premium ? 'Анимированная реакция Asteria Premium' : 'Доступно с Asteria Premium';
    b.addEventListener('click', () => {
      if (!premium) { alert(`Анимированные реакции — привилегия Asteria Premium (${PREMIUM_PRICE_LABEL}). Подписку выдаёт администратор.`); return; }
      sendReaction(messageId, emoji);
      if (afterClick) afterClick();
    });
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
      media.push({ msgId: m.id, itemIdx: null, url: m.mediaUrl, type: m.msgType });
    } else if (m.msgType === 'album' && m.meta && Array.isArray(m.meta.items)) {
      m.meta.items.forEach((it, idx) => {
        media.push({ msgId: m.id, itemIdx: idx, url: it.url, type: it.kind === 'video' ? 'video' : 'image' });
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
function guessMediaFilename(url, type, idx) {
  const ext = (url.split('.').pop() || (type === 'video' ? 'mp4' : 'jpg')).split('?')[0];
  const suffix = idx === undefined ? '' : `-${idx}`;
  return `asteria-${type === 'video' ? 'video' : 'photo'}-${Date.now()}${suffix}.${ext}`;
}

async function downloadMediaBatch(items) {
  // 1) Нативная Android-обёртка — тут ничего не меняем, у неё свой мост в
  //    системный DownloadManager с реальным сохранением в галерею.
  if (window.AsteriaNotify && typeof window.AsteriaNotify.downloadMedia === 'function') {
    items.forEach((it, i) => {
      const filename = guessMediaFilename(it.url, it.type, items.length > 1 ? i : undefined);
      window.AsteriaNotify.downloadMedia(it.url, filename, it.type === 'video' ? 'video/mp4' : 'image/jpeg');
    });
    return 'native';
  }

  // 2) Обычный браузер (в т.ч. Safari/iOS) — открываем ссылку на медиафайл
  //    напрямую, точно так же, как уже работает скачивание обычных файлов
  //    (см. file-chip выше: `<a href="${m.mediaUrl}" target="_blank">`).
  //    Дальше это уже поведение самого браузера: Safari откроет фото/видео
  //    во весь экран, откуда его можно сохранить долгим тапом → "Добавить
  //    в Фото" / кнопкой "Поделиться", а десктоп-браузеры обычно сразу
  //    открывают файл в новой вкладке или предлагают его сохранить.
  items.forEach((it) => {
    const a = document.createElement('a');
    a.href = it.url;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  return 'opened';
}

async function downloadCurrentLightboxMedia() {
  const { src, type } = lightboxState;
  if (!src) return;
  const btn = $('#lightboxDownloadBtn');
  btn.classList.add('downloading');
  try {
    const result = await downloadMediaBatch([{ url: src, type }]);
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

function sendWSMessage(msgType, content, mediaUrl, meta) {
  if (!state.activeConvId) return;
  const replyToId = state.replyingTo ? state.replyingTo.id : null;
  state.ws.send(JSON.stringify({
    type: 'message', conversationId: state.activeConvId, msgType, content: content || '', mediaUrl: mediaUrl || null, meta: meta || null, replyToId,
  }));
  cancelReply();
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

function openMiniApp(url, title) {
  if (!url) return;
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
  if (m.msgType === 'text') return m.content;
  const map = { image: '🖼 Фото', video: '🎬 Видео', video_circle: '🎥 Видеосообщение', voice: '🎙 Голосовое сообщение', music: '🎵 Трек', file: '📄 Файл', sticker: '😊 Стикер', poll: '📊 ' + (m.content || 'Опрос'), location: '📍 Геолокация', album: '🖼 Альбом' };
  return map[m.msgType] || m.content || '';
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

$('#attachBtn').addEventListener('click', () => { $('#attachMenu').classList.toggle('hidden'); $('#stickerPanel').classList.add('hidden'); });
$all('#attachMenu button').forEach((btn) => {
  btn.addEventListener('click', () => {
    $('#attachMenu').classList.add('hidden');
    const kind = btn.dataset.kind;
    if (kind === 'poll') { openPollCreateModal(); return; }
    if (kind === 'location') { sendLocationMessage(); return; }
    const map = { image: '#fileInputImage', video: '#fileInputVideo', file: '#fileInputFile', music: '#fileInputMusic' };
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
let pollOptionCount = 0;

function pollOptionRow(index, value) {
  const row = document.createElement('div');
  row.className = 'poll-option-row';
  row.dataset.index = index;
  row.innerHTML = `
    <input type="text" class="poll-option-input" placeholder="Вариант ${index + 1}" maxlength="120" value="${escapeHtml(value || '')}">
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
  const question = $('#pollQuestionInput').value.trim();
  if (!question) { $('#pollError').textContent = 'Введите вопрос'; return; }
  const options = $all('#pollOptionsList .poll-option-input')
    .map((inp) => inp.value.trim())
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

function renderPollBubble(m) {
  const meta = m.meta || { options: [], votes: {}, maxChoices: 1 };
  const votes = meta.votes || {};
  const totalVoters = totalPollVoters(m);
  const mySelections = pollUserVotes(m);

  let html = `<div class="poll-bubble">
    <div class="poll-question">📊 ${escapeHtml(meta.question || m.content)}</div>
    <div class="poll-meta-line">${meta.maxChoices > 1 ? `Можно выбрать до ${meta.maxChoices}` : 'Один вариант ответа'}</div>`;

  meta.options.forEach((opt) => {
    const count = (votes[opt.id] || []).length;
    const pct = totalVoters ? Math.round((count / totalVoters) * 100) : 0;
    const mine = mySelections.includes(opt.id);
    html += `
      <div class="poll-option${mine ? ' mine' : ''}" data-opt="${opt.id}">
        <div class="poll-option-fill" style="width:${pct}%"></div>
        <div class="poll-option-top">
          <span class="poll-option-text"><span class="poll-option-check"></span>${escapeHtml(opt.text)}</span>
          <span class="poll-option-pct">${totalVoters ? pct + '%' : ''}</span>
        </div>
      </div>`;
  });

  html += `<div class="poll-total-votes">${totalVoters ? totalVoters + ' ' + pluralVotes(totalVoters) : 'Пока никто не проголосовал'}</div></div>`;
  return html;
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

async function uploadFile(file, kind) {
  const dataBase64 = await fileToBase64(file);
  const { url } = await api('/api/upload', { method: 'POST', body: { filename: file.name, dataBase64, kind } });
  return url;
}

// Фото — одно (через предпросмотр с подписью) или сразу несколько
// (до 10 штук за раз — общая модалка мини-галереи, см. openMediaBatch).
$('#fileInputImage').addEventListener('change', () => {
  const files = $('#fileInputImage').files;
  if (!files.length) return;
  if (files.length === 1) {
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
    openMediaBatch(files, 'image');
  }
  $('#fileInputImage').value = '';
});
$('#imagePreviewSendBtn').addEventListener('click', async () => {
  if (!state.pendingImageFile) return;
  const file = state.pendingImageFile;
  const caption = $('#imagePreviewCaption').value.trim();
  $('#imagePreviewModal').classList.add('hidden');
  const url = await uploadFile(file, 'image');
  sendWSMessage('image', caption, url, { name: file.name, size: file.size, mime: file.type });
  state.pendingImageFile = null;
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
    if (files.length > 1 && msgType === 'video') {
      openMediaBatch(files, 'video');
      inputEl.value = '';
      return;
    }
    const file = files[0];
    const url = await uploadFile(file, msgType);
    sendWSMessage(msgType, '', url, { name: file.name, size: file.size, mime: file.type });
    inputEl.value = '';
  });
}
handleFileInput($('#fileInputVideo'), 'video');
handleFileInput($('#fileInputFile'), 'file');
handleFileInput($('#fileInputMusic'), 'music');

/* ---------------- ОТПРАВКА НЕСКОЛЬКИХ ФОТО/ВИДЕО ЗА РАЗ (до 10) ---------------- */

const MAX_MEDIA_BATCH = 10;

// Открывает общую модалку-"мини-галерею" для отправки сразу нескольких
// фото или видео (можно выбрать в системном пикере несколько файлов —
// FileList — сразу; лишнее сверх лимита молча отбрасываем с тостом).
function openMediaBatch(fileList, kind) {
  const all = Array.from(fileList);
  state.mediaBatchFiles = all.slice(0, MAX_MEDIA_BATCH).map((file) => ({ file, kind }));
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
    item.innerHTML = entry.kind === 'video' ? `<video src="${url}" muted playsinline></video>` : `<img src="${url}">`;
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
  // Один файл — просто как обычное фото/видео, без коллажа (коллаж имеет
  // смысл только когда файлов больше одного).
  if (entries.length === 1) {
    const { file, kind } = entries[0];
    try {
      const url = await uploadFile(file, kind);
      sendWSMessage(kind, caption, url, { name: file.name, size: file.size, mime: file.type });
    } catch (e) {
      showToast(`Не удалось отправить «${file.name}»`);
    }
    return;
  }
  // Несколько фото/видео разом — отправляем ОДНИМ сообщением-альбомом
  // (коллажом), как альбомы в Telegram, а не отдельным сообщением на
  // каждый файл. Порядок загрузки — по очереди (не Promise.all), чтобы
  // порядок элементов в альбоме гарантированно совпадал с порядком в
  // мини-галерее, а не зависел от того, какая загрузка на сервер
  // завершилась быстрее.
  const items = [];
  for (let i = 0; i < entries.length; i++) {
    const { file, kind } = entries[i];
    try {
      const url = await uploadFile(file, kind);
      items.push({ url, kind, name: file.name, size: file.size, mime: file.type });
    } catch (e) {
      showToast(`Не удалось отправить «${file.name}»`);
    }
  }
  if (items.length === 1) {
    const it = items[0];
    sendWSMessage(it.kind, caption, it.url, { name: it.name, size: it.size, mime: it.mime });
  } else if (items.length > 1) {
    sendWSMessage('album', caption, null, { items });
  }
});

/* ---------------- ПЕРЕСЫЛКА СООБЩЕНИЙ ---------------- */

// Чаты, куда вообще можно что-то переслать: личные и групповые — всегда,
// каналы — только если я в них могу постить (владелец или админ сайта) —
// та же логика, что и в основном композере (см. canPostInConv).
function forwardableConversations() {
  return state.conversations.filter((c) => {
    if (c.type === 'dm') return true;
    if (c.type === 'group') return true;
    if (c.type === 'channel') return c.ownerId === state.user.id || !!state.user.isAdmin;
    return false;
  });
}

function openForwardPicker(m) {
  state.forwardMessage = m;
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
  btn.textContent = n ? `Переслать (${n})` : 'Переслать';
}

$('#forwardSendBtn').addEventListener('click', () => {
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



/* ---------------- STICKERS ---------------- */

const stickerPanel = $('#stickerPanel');
STICKERS.forEach((s) => {
  const b = document.createElement('button');
  b.textContent = s;
  b.addEventListener('click', () => { sendWSMessage('sticker', s); stickerPanel.classList.add('hidden'); });
  stickerPanel.appendChild(b);
});
$('#stickerBtn').addEventListener('click', () => { stickerPanel.classList.toggle('hidden'); $('#attachMenu').classList.add('hidden'); });

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
$('#formatBtn').addEventListener('click', () => { $('#formatMenu').classList.toggle('hidden'); $('#attachMenu').classList.add('hidden'); stickerPanel.classList.add('hidden'); });
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
  if (!e.target.closest('#attachBtn') && !e.target.closest('#attachMenu')) $('#attachMenu').classList.add('hidden');
  if (!e.target.closest('#stickerBtn') && !e.target.closest('#stickerPanel')) stickerPanel.classList.add('hidden');
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

/* ---------------- VOICE MESSAGES ---------------- */


async function startVoiceRecording() {
  try {
    const stream = await getMedia({ audio: true });
    state.voiceStream = stream;
    state.voiceChunks = [];
    state.voiceMime = pickRecorderMime(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac']);
    const rec = state.voiceMime ? new MediaRecorder(stream, { mimeType: state.voiceMime }) : new MediaRecorder(stream);
    state.voiceRecorder = rec;
    rec.ondataavailable = (e) => { if (e.data.size) state.voiceChunks.push(e.data); };
    rec.start();
    state.voiceTranscriber = startLiveTranscription();
    state.voiceStartedAt = Date.now();
    $('#voiceRecordingBar').classList.remove('hidden');
    state.voiceTimerInt = setInterval(() => {
      const sec = Math.floor((Date.now() - state.voiceStartedAt) / 1000);
      $('#voiceTimer').textContent = `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`;
    }, 500);
  } catch (e) { alert('Нет доступа к микрофону: ' + e.message); }
}

function stopVoiceRecording(send) {
  const rec = state.voiceRecorder;
  if (!rec) return;
  rec.onstop = async () => {
    clearInterval(state.voiceTimerInt);
    $('#voiceRecordingBar').classList.add('hidden');
    state.voiceStream.getTracks().forEach((t) => t.stop());
    const transcriber = state.voiceTranscriber;
    state.voiceTranscriber = null;
    const transcript = transcriber ? await transcriber.stop() : '';
    if (send && state.voiceChunks.length) {
      const mime = state.voiceMime || 'audio/webm';
      const ext = extForMime(mime);
      const blob = new Blob(state.voiceChunks, { type: mime });
      const file = new File([blob], `voice.${ext}`, { type: mime });
      const url = await uploadFile(file, 'voice');
      sendWSMessage('voice', '', url, transcript ? { transcript } : {});
    }
  };
  rec.stop();
}

/* ---------------- VIDEO CIRCLE (кружки) ---------------- */

async function sendCircleVideo(transcript) {
  const mime = state.circleMime || 'video/webm';
  const ext = extForMime(mime);
  const blob = new Blob(state.circleChunks, { type: mime });
  const file = new File([blob], `circle.${ext}`, { type: mime });
  const url = await uploadFile(file, 'circle');
  sendWSMessage('video_circle', '', url, transcript ? { transcript } : {});
  closeCircleModal();
}

function closeCircleModal() {
  $('#circleRecordModal').classList.add('hidden');
  $('#circleRecordModal').classList.remove('recording');
  stopCircleTimerUi();
  if (state.circleStream) state.circleStream.getTracks().forEach((t) => t.stop());
  state.circleStream = null;
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

function setCircleLocked(v) {
  circleLocked = v;
  $('#circleRecordLockBtn').classList.toggle('locked', v);
}

// Смена камеры прямо во время записи: заменяем видеодорожку в уже
// работающем MediaStream (аудиодорожка и сам MediaRecorder не трогаются).
async function flipCircleCamera() {
  if (!state.circleStream) return;
  const oldTrack = state.circleStream.getVideoTracks()[0];
  if (!oldTrack) return;
  const nextFacing = circleRecFacing === 'environment' ? 'user' : 'environment';
  try {
    const newStream = await getMedia({ video: { facingMode: nextFacing }, audio: false }, { silent: true });
    const newTrack = newStream.getVideoTracks()[0];
    if (!newTrack) return;
    state.circleStream.removeTrack(oldTrack);
    oldTrack.stop();
    state.circleStream.addTrack(newTrack);
    $('#circlePreview').srcObject = state.circleStream;
    circleRecFacing = nextFacing;
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

async function beginHoldRecording() {
  recordActive = true;
  if (recordMode === 'voice') {
    await startVoiceRecording();
  } else {
    circleFlashOn = false;
    circleRecFacing = 'user';
    setCircleLocked(false);
    $('#circleFlashBtn').classList.remove('active');
    showModal('#circleRecordModal');
    $('#circleRecordModal').classList.add('recording');
    try {
      const stream = await getMedia({ video: { facingMode: circleRecFacing }, audio: true });
      state.circleStream = stream;
      $('#circlePreview').srcObject = stream;
      state.circleChunks = [];
      state.circleMime = pickRecorderMime(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4;codecs=h264,aac', 'video/mp4']);
      const rec = state.circleMime ? new MediaRecorder(stream, { mimeType: state.circleMime }) : new MediaRecorder(stream);
      state.circleRecorder = rec;
      rec.ondataavailable = (e) => { if (e.data.size) state.circleChunks.push(e.data); };
      rec.start();
      state.circleTranscriber = startLiveTranscription();
      startCircleTimerUi();
      state.circleAutoStopTimer = setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, CIRCLE_MAX_MS);
    } catch (e) {
      alert('Нет доступа к камере: ' + e.message);
      recordActive = false;
      closeCircleModal();
    }
  }
}

function endHoldRecording(send) {
  if (!recordActive) return;
  recordActive = false;
  if (recordMode === 'voice') {
    stopVoiceRecording(send);
  } else {
    clearTimeout(state.circleAutoStopTimer);
    stopCircleTimerUi();
    const rec = state.circleRecorder;
    if (!rec || rec.state === 'inactive') { closeCircleModal(); return; }
    rec.onstop = async () => {
      const transcriber = state.circleTranscriber;
      state.circleTranscriber = null;
      const transcript = transcriber ? await transcriber.stop() : '';
      if (send && state.circleChunks.length) await sendCircleVideo(transcript);
      else closeCircleModal();
    };
    rec.stop();
  }
}

const recordBtnEl = $('#recordBtn');
recordBtnEl.addEventListener('pointerdown', (e) => {
  if (e.button !== undefined && e.button !== 0) return;
  recordStartX = e.clientX; recordStartY = e.clientY;
  try { recordBtnEl.setPointerCapture(e.pointerId); } catch (err) {}
  clearTimeout(recordHoldTimer);
  recordHoldTimer = setTimeout(beginHoldRecording, RECORD_HOLD_MS);
});
recordBtnEl.addEventListener('pointerup', (e) => {
  clearTimeout(recordHoldTimer);
  if (recordActive) {
    // Запись-кружок залочена (тап по 🔓 в оверлее) — отпускание кнопки её
    // больше не останавливает, ждём тап по шаттеру или "Отменить".
    if (recordMode === 'circle' && circleLocked) return;
    const draggedUp = (recordStartY - e.clientY) > RECORD_CANCEL_DRAG_PX;
    endHoldRecording(!draggedUp);
  } else {
    // короткий тап — переключаем режим
    recordMode = recordMode === 'voice' ? 'circle' : 'voice';
    updateRecordBtnUi();
  }
});
recordBtnEl.addEventListener('pointercancel', () => {
  clearTimeout(recordHoldTimer);
  if (recordActive && !(recordMode === 'circle' && circleLocked)) endHoldRecording(false);
});
recordBtnEl.addEventListener('contextmenu', (e) => e.preventDefault());

// Кнопки полноэкранного оверлея записи кружка.
$('#circleRecordCancelBtn').addEventListener('click', () => endHoldRecording(false));
$('#circleShutterBtn').addEventListener('click', () => endHoldRecording(true));
$('#circleRecordLockBtn').addEventListener('click', () => setCircleLocked(!circleLocked));
$('#circleFlipBtn').addEventListener('click', flipCircleCamera);
$('#circleFlashBtn').addEventListener('click', toggleCircleFlash);

/* ---------------- MODALS generic ---------------- */

$all('.modal-close').forEach((btn) => btn.addEventListener('click', () => {
  const id = btn.dataset.close;
  $('#' + id).classList.add('hidden');
  if (id === 'circleRecordModal') closeCircleModal();
}));

/* ---------------- SETTINGS (теперь отдельный раздел, не модалка) ---------------- */

function toggleAvatarRing(el, u) {
  if (!el) return;
  // Кольцо вокруг аватара отключено — для Premium остаётся только значок.
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
    if (state.user.status) parts.push(state.user.status);
    hdrSub.textContent = parts.join(' • ');
  }
}

/* ---------------- НАСТРОЙКИ: список пунктов и дочерние страницы ---------------- */

const SETTINGS_SUBPAGES = {
  premium:       { titleKey: 'settings_premium',       title: 'Asteria Premium',       el: 'subPagePremium' },
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
  // когда открыт конкретный пункт настроек (профиль, Premium и т.д.) —
  // так же, как она прячется при открытом чате (см. .chat-open ниже).
  $('#appScreen').classList.add('settings-sub-open');
  $('#settingsSubTitle').textContent = (typeof t === 'function') ? t(cfg.titleKey) : cfg.title;
  $all('.settings-sub-page').forEach((p) => p.classList.add('hidden'));
  $('#' + cfg.el).classList.remove('hidden');
  $('#profileEditToggleBtn').classList.toggle('hidden', key !== 'profile');
  if (key === 'profile') {
    populateProfileViewInfo();
    setProfileEditMode(false);
  }
  if (key === 'privacy') {
    $('#discoverableCheckbox').checked = state.user.discoverable !== false;
    refreshHideOnlineCheckbox();
    refreshHideReadStatusCheckbox();
    $('#passwordError').textContent = '';
    $('#currentPasswordInput').value = '';
    $('#newPasswordInput').value = '';
    $all('#passwordStrength span').forEach((b) => b.className = '');
    $all('.password-toggle-eye').forEach((btn) => { const inp = $('#' + btn.dataset.toggle); if (inp) inp.type = 'password'; btn.textContent = '👁'; });
  }
  if (key === 'folders') renderFoldersInSettings();
  if (key === 'devices') renderDevicesInSettings();
  if (key === 'appearance') { highlightActiveThemeSwatch(); renderWallpaperPresets(); }
  if (key === 'premium') renderPremiumSettingsPage();
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
$('#settingsSubBackBtn').addEventListener('click', closeSettingsSubpage);
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
  updatePremiumStatusValue();
}
function renderPremiumSettingsPage() {
  const u = state.user;
  const active = isPremiumActive(u);
  const hero = $('#premiumHero');
  const title = $('#premiumHeroTitle');
  const sub = $('#premiumHeroSub');
  const howTo = $('#premiumHowToGet');
  if (hero) hero.classList.toggle('premium-hero-active', active);
  if (active) {
    title.textContent = 'У вас есть Asteria Premium';
    sub.textContent = u.premiumUntil ? `Действует до ${fmtDate(u.premiumUntil)}` : 'Подписка оформлена бессрочно';
    howTo.textContent = 'Спасибо за поддержку Asteria! Все привилегии из списка ниже уже активны на вашем аккаунте.';
  } else {
    title.textContent = 'Asteria Premium';
    sub.textContent = PREMIUM_PRICE_LABEL;
    howTo.textContent = 'Подписка не продаётся напрямую в приложении — оформить её может только администратор через админ-панель. Если хотите Premium, напишите администратору.';
  }
  highlightActiveThemeSwatch();
  renderWallpaperPresets();
}
function updatePremiumStatusValue() {
  const el = $('#premiumStatusValue');
  if (!el) return;
  if (isPremiumActive(state.user)) {
    el.textContent = state.user.premiumUntil ? 'до ' + fmtDate(state.user.premiumUntil) : 'бессрочно';
    el.classList.add('sli-value-premium-active');
  } else {
    el.textContent = PREMIUM_PRICE_LABEL;
    el.classList.remove('sli-value-premium-active');
  }
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
  let premium = false;
  let lockedSet = null;
  try { premium = isPremiumActive(state.user); lockedSet = PREMIUM_THEME_VALUES; } catch (e) { /* вызвано до полной инициализации скрипта — при самом первом запуске страницы */ }
  $all('.theme-swatch').forEach((s) => {
    s.classList.toggle('active', s.dataset.themeValue === currentThemePref);
    if (lockedSet) s.classList.toggle('locked', lockedSet.has(s.dataset.themeValue) && !premium);
  });
}
$all('.theme-swatch').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const value = btn.dataset.themeValue;
    if (PREMIUM_THEME_VALUES.has(value) && !isPremiumActive(state.user)) {
      alert(`Тема «${btn.textContent.replace('⭐', '').trim()}» доступна только с Asteria Premium (${PREMIUM_PRICE_LABEL}). Подписку выдаёт администратор.`);
      return;
    }
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

// Сетка фонов чата: плитка сброса по умолчанию, бесплатная галерея (доступна
// всем) и отдельная premium-плитка «Своё фото» — белая, с плюсом по центру,
// открывает выбор файла с устройства. Обычным пользователям показывается
// залоченной, клик объясняет про подписку.
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
  const premium = isPremiumActive(state.user);
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

  // Premium-плитка: своё фото с устройства
  const uploadBtn = document.createElement('button');
  uploadBtn.className = 'wallpaper-preset wallpaper-preset-upload' + (premium ? '' : ' locked');
  uploadBtn.title = premium ? 'Загрузить своё фото' : 'Своё фото — доступно с Asteria Premium';
  uploadBtn.innerHTML = premium
    ? `<span class="wallpaper-preset-plus">+</span><span class="wallpaper-preset-label">Своё фото</span>`
    : `<span class="wallpaper-preset-plus">+</span><span class="wallpaper-preset-lock">⭐</span>`;
  uploadBtn.addEventListener('click', () => {
    if (!premium) { alert(`Загрузка своего фона — привилегия Asteria Premium (${PREMIUM_PRICE_LABEL}). Подписку выдаёт администратор.`); return; }
    $('#wallpaperInput').click();
  });
  el.appendChild(uploadBtn);
}


// Чекбокс «Скрыть статус в сети» — доступен только с Premium. Не-Premium
// пользователю показываем его затемнённым и не даём включить (как и
// premium-темы/своё фото на фон — см. аналогичные проверки выше).
function refreshHideOnlineCheckbox() {
  const cb = $('#hideOnlineCheckbox');
  const row = $('#hideOnlineRow');
  if (!cb) return;
  const premium = isPremiumActive(state.user);
  cb.checked = premium && !!state.user.hideOnlineStatus;
  if (row) row.classList.toggle('locked', !premium);
}
const hideOnlineCb = $('#hideOnlineCheckbox');
if (hideOnlineCb) {
  hideOnlineCb.addEventListener('change', () => {
    if (hideOnlineCb.checked && !isPremiumActive(state.user)) {
      hideOnlineCb.checked = false;
      alert(`Скрыть статус «в сети» — привилегия Asteria Premium (${PREMIUM_PRICE_LABEL}). Подписку выдаёт администратор.`);
      return;
    }
    // Раньше здесь ничего не сохранялось — переключатель менял только
    // локальный .checked, а на сервер (PATCH /api/me) значение уходило
    // лишь при нажатии кнопки "Сохранить" на СТРАНИЦЕ ПРОФИЛЯ (там, где
    // #saveSettingsBtn). На подстранице "Конфиденциальность" такой кнопки
    // нет, поэтому переключение здесь визуально срабатывало, но при
    // перезагрузке страницы откатывалось — сервер о нём просто не узнавал.
    savePrivacySettings();
  });
}

// Чекбокс «Скрыть отметки о прочтении» — новая Premium-фича: если включена,
// собеседники в личных чатах никогда не увидят синюю точку «прочитано» у
// отправленных вам сообщений, даже если вы их уже открыли (сам счётчик
// непрочитанных у вас при этом продолжает работать как обычно).
function refreshHideReadStatusCheckbox() {
  const cb = $('#hideReadStatusCheckbox');
  const row = $('#hideReadStatusRow');
  if (!cb) return;
  const premium = isPremiumActive(state.user);
  cb.checked = premium && !!state.user.hideReadStatus;
  if (row) row.classList.toggle('locked', !premium);
}
const hideReadStatusCb = $('#hideReadStatusCheckbox');
if (hideReadStatusCb) {
  hideReadStatusCb.addEventListener('change', () => {
    if (hideReadStatusCb.checked && !isPremiumActive(state.user)) {
      hideReadStatusCb.checked = false;
      alert(`Скрыть отметки о прочтении — привилегия Asteria Premium (${PREMIUM_PRICE_LABEL}). Подписку выдаёт администратор.`);
      return;
    }
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
    // Если сервер отклонил запрос (например, гонка с истёкшим Premium),
    // возвращаем чекбоксы в состояние, которое реально хранится на сервере,
    // чтобы UI не "врал" о применённой настройке.
    $('#discoverableCheckbox').checked = state.user.discoverable !== false;
    refreshHideOnlineCheckbox();
    refreshHideReadStatusCheckbox();
    alert(err.message);
  }
}

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

function buildInviteLink(code) { return `${location.origin}/j/${code}`; }
function buildProfileLink(username) { return `${location.origin}/u/${username}`; }

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
    row.innerHTML = `<div class="avatar" style="${u.avatar ? avatarStyle(u) : ''}">${u.avatar ? '' : initials(u.displayName)}</div><div><div>${escapeHtml(u.displayName)}${verifiedBadge(u)}${premiumBadge(u)}</div><div class="chat-header-sub">@${escapeHtml(u.username)}</div></div>`;
    row.addEventListener('click', () => {
      composeFoundUser = u;
      $('#composeContactPreview').innerHTML = `<div class="avatar" style="${u.avatar ? avatarStyle(u) : ''}">${u.avatar ? '' : initials(u.displayName)}</div><div><div>${escapeHtml(u.displayName)}${verifiedBadge(u)}${premiumBadge(u)}</div><div class="chat-header-sub">@${escapeHtml(u.username)}</div></div>`;
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

function renderStories(stories) {
  const byUser = {};
  stories.forEach((s) => { (byUser[s.userId] = byUser[s.userId] || []).push(s); });
  const el = $('#storiesStrip');
  el.innerHTML = '';

  const mine = document.createElement('div');
  mine.className = 'story-item';
  const mineHasPhoto = !!state.user.avatar;
  mine.innerHTML = `<div class="story-avatar story-add"><div class="story-avatar-inner" style="${mineHasPhoto ? avatarStyle(state.user) : ''}">${mineHasPhoto ? '' : (byUser[state.user.id] ? initials(state.user.displayName) : '＋')}</div></div><span>Ваша история</span>`;
  mine.addEventListener('click', () => {
    if (byUser[state.user.id]) viewStories(byUser[state.user.id], state.user);
    else openCreateStoryModal();
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
  if (mineHasPhoto) preloadAvatarAndRepaint(mine.querySelector('.story-avatar-inner'), state.user.avatar);

  Object.keys(byUser).forEach((uid) => {
    if (uid === state.user.id) return;
    const u = state.usersById[uid] || { displayName: '?' };
    const item = document.createElement('div');
    item.className = 'story-item';
    item.innerHTML = `<div class="story-avatar"><div class="story-avatar-inner" style="${u.avatar ? avatarStyle(u) : ''}">${u.avatar ? '' : initials(u.displayName)}</div></div><span>${escapeHtml(u.displayName)}</span>`;
    item.addEventListener('click', () => viewStories(byUser[uid], u));
    el.appendChild(item);
  });

  renderMiniStories();
}

// Мини-версия первых 3 историй — показывается рядом со словом "Чаты", когда
// список чатов сворачивает .stories-strip при скролле вниз (см. setupStoriesCollapseOnScroll).
function renderMiniStories() {
  const source = $('#storiesStrip');
  const miniEl = $('#miniStories');
  if (!source || !miniEl) return;
  miniEl.innerHTML = '';
  const items = Array.from(source.querySelectorAll('.story-item')).slice(0, 3);
  items.forEach((item) => {
    const inner = item.querySelector('.story-avatar-inner');
    if (!inner) return;
    const mini = document.createElement('div');
    mini.className = 'mini-story-avatar';
    mini.innerHTML = `<div class="mini-story-avatar-inner" style="${inner.getAttribute('style') || ''}">${inner.style.backgroundImage ? '' : inner.textContent}</div>`;
    mini.addEventListener('click', () => item.click());
    miniEl.appendChild(mini);
  });
}

// Сворачивание/разворачивание строки историй при скролле списка чатов:
// вниз — истории складываются в 3 мини-аватара у слова "Чаты", наверх (в самый
// верх списка) — разворачиваются обратно.
//
// Раньше при быстрой прокрутке колесом порог сворачивания/разворачивания
// пересекался по несколько раз за доли секунды, а CSS-анимация (.34s) не
// успевала закончиться — из-за этого блок историй/поиска дёргался туда-сюда
// и наезжал на верхние чаты. Чтобы это исправить:
// 1) обрабатываем скролл не чаще раза за кадр (requestAnimationFrame),
// 2) пока анимация сворачивания/разворачивания не завершилась, новые
//    переключения игнорируем (LOCK_MS ~= длительности CSS-transition),
// 3) разворачиваем только когда список долистан строго до самого верха.
function setupStoriesCollapseOnScroll() {
  const sidebar = $('#sidebar');
  const lists = [$('#convList'), $('#chatsSearchResults')].filter(Boolean);
  const COLLAPSE_AT = 40;
  const EXPAND_AT = 0;
  const LOCK_MS = 360;
  let collapsed = false;
  let locked = false;
  let rafPending = false;
  let lastTop = 0;

  const applyState = () => {
    rafPending = false;
    const top = lastTop;
    if (locked) return;
    if (!collapsed && top > COLLAPSE_AT) {
      collapsed = true;
      locked = true;
      sidebar.classList.add('stories-collapsed');
      setTimeout(unlockAndRecheck, LOCK_MS);
    } else if (collapsed && top <= EXPAND_AT) {
      collapsed = false;
      locked = true;
      sidebar.classList.remove('stories-collapsed');
      setTimeout(unlockAndRecheck, LOCK_MS);
    }
  };

  function unlockAndRecheck() {
    locked = false;
    // На случай если пользователь остановил скролл прямо во время блокировки:
    // сверяем состояние с актуальным scrollTop видимого списка, а не ждём
    // следующего события scroll, которого может и не быть.
    const visibleList = lists.find((l) => l.offsetParent !== null) || lists[0];
    if (visibleList) {
      lastTop = visibleList.scrollTop;
      applyState();
    }
  }

  const onScroll = (e) => {
    lastTop = e.target.scrollTop;
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(applyState);
    }
  };
  lists.forEach((list) => list.addEventListener('scroll', onScroll, { passive: true }));
}
setupStoriesCollapseOnScroll();

function viewStories(stories, user) {
  let idx = 0;
  const modal = $('#storyModal');
  const viewer = $('#storyViewer');
  function render() {
    if (!stories.length) { modal.classList.add('hidden'); return; }
    const s = stories[idx];
    const isMine = s.userId === state.user.id;
    viewer.innerHTML = `<button class="story-close">✕</button>` +
      (s.mediaType === 'video' ? `<video src="${s.mediaUrl}" autoplay controls></video>` : `<img src="${s.mediaUrl}">`) +
      (isMine ? `<button class="story-delete-btn" title="Удалить историю">🗑</button>` : '') +
      (s.caption ? `<div class="story-caption">${escapeHtml(s.caption)}</div>` : '');
    viewer.querySelector('.story-close').addEventListener('click', () => modal.classList.add('hidden'));
    const delBtn = viewer.querySelector('.story-delete-btn');
    if (delBtn) {
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Удалить эту историю?')) return;
        try {
          await api(`/api/stories/${s.id}`, { method: 'DELETE' });
          stories.splice(idx, 1);
          if (idx >= stories.length) idx = 0;
          render();
          loadStories();
        } catch (err) { alert(err.message); }
      });
    }
    viewer.addEventListener('click', (e) => {
      if (e.target.closest('.story-close') || e.target.closest('.story-delete-btn')) return;
      idx = (idx + 1) % stories.length;
      render();
    }, { once: true });
  }
  render();
  showModal(modal);
}

let storyPickedFile = null;
function openCreateStoryModal() {
  storyPickedFile = null;
  $('#storyPreviewWrap').innerHTML = '';
  $('#storyCaption').value = '';
  showModal('#createStoryModal');
}
$('#storyPickFileBtn').addEventListener('click', () => $('#storyFileInput').click());
$('#storyFileInput').addEventListener('change', () => {
  const file = $('#storyFileInput').files[0];
  if (!file) return;
  storyPickedFile = file;
  const url = URL.createObjectURL(file);
  $('#storyPreviewWrap').innerHTML = file.type.startsWith('video') ? `<video src="${url}" controls></video>` : `<img src="${url}">`;
});
$('#publishStoryBtn').addEventListener('click', async () => {
  if (!storyPickedFile) { alert('Выберите фото или видео'); return; }
  const url = await uploadFile(storyPickedFile, 'story');
  await api('/api/stories', { method: 'POST', body: { mediaUrl: url, mediaType: storyPickedFile.type.startsWith('video') ? 'video' : 'image', caption: $('#storyCaption').value.trim() } });
  $('#createStoryModal').classList.add('hidden');
  loadStories();
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
      const name = c.peer ? c.peer.displayName : 'Неизвестный';
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
  if (state.currentCallPeerId) state.ws.send(JSON.stringify({ type: 'call-media-toggle', to: state.currentCallPeerId, kind: 'video', enabled: state.camOn }));
}

async function flipCamera() {
  if (!state.localStream || !state.hasCamera) return;
  const oldTrack = state.localStream.getVideoTracks()[0];
  if (!oldTrack) return;
  const nextFacing = state.currentFacingMode === 'environment' ? 'user' : 'environment';
  try {
    const newStream = await getMedia({ video: { facingMode: nextFacing }, audio: false }, { silent: true });
    const newTrack = newStream.getVideoTracks()[0];
    if (!newTrack) return;
    newTrack.enabled = state.camOn;
    if (state.peerConn) {
      const sender = state.peerConn.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(newTrack);
    }
    state.localStream.removeTrack(oldTrack);
    oldTrack.stop();
    state.localStream.addTrack(newTrack);
    $('#localVideo').srcObject = state.localStream;
    state.currentFacingMode = nextFacing;
  } catch (e) {
    alert('Не удалось переключить камеру: ' + (e.message || 'неизвестная ошибка'));
  }
}

// Диагностика звонков ([CALL-DIAG]) — пишет и в консоль браузера (если есть
// доступ к ней), и, дополнительно, отправляет ту же строку на сервер по уже
// открытому WS-соединению — сервер просто печатает её в своём терминале
// (см. обработку 'client-log' в server.js). Это специально сделано для
// случаев вроде iPhone без Mac, где к консоли Safari иначе не подобраться —
// администратору достаточно смотреть в терминал сервера, откуда он и так
// обычно следит за логами.
function callDiag(...args) {
  const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  console.log('[CALL-DIAG]', text);
  try {
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify({ type: 'client-log', text: '[CALL-DIAG] ' + text }));
    }
  } catch (e) { /* не критично — это просто диагностика */ }
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
    callDiag('acquireCallMedia: получены дорожки:', stream.getTracks().map((t) => `${t.kind}(${t.readyState}, enabled=${t.enabled}, label="${t.label}")`).join(' | '));
    return stream;
  } catch (e) {
    state.hasCamera = false;
    callDiag('acquireCallMedia: видео+аудио не удалось, пробуем только аудио. Ошибка:', e && e.name, e && e.message);
    return await getMedia({ video: false, audio: true });
  }
}

function attachPeerConnectionHandlers(pc) {
  // ДИАГНОСТИКА: строки [CALL-DIAG] уходят и в консоль браузера, и на
  // сервер (см. callDiag выше) — смотреть их проще всего в терминале
  // сервера, специальные инструменты разработчика на телефоне не нужны.
  const diag = (...args) => callDiag(new Date().toISOString().slice(11, 23), ...args);
  diag('pc создан');

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      const c = e.candidate.candidate || '';
      const typeMatch = c.match(/typ (\w+)/);
      const protoMatch = c.match(/^candidate:\S+ \d+ (\w+)/);
      diag('ICE-кандидат собран:', typeMatch ? typeMatch[1] : '?', 'proto=', protoMatch ? protoMatch[1] : '?');
      state.ws.send(JSON.stringify({ type: 'call-ice', to: state.currentCallPeerId, candidate: e.candidate }));
    } else {
      diag('сбор ICE-кандидатов завершён (null candidate)');
    }
  };
  pc.ontrack = (e) => {
    const stream = e.streams[0];
    diag('ontrack:', e.track.kind, 'streamTracks=', stream ? stream.getTracks().map((t) => t.kind + ':' + t.readyState).join(',') : 'нет потока');
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
    diag('iceConnectionState →', st);
    if (st === 'connected' || st === 'completed') {
      // Самое полезное: какая именно пара кандидатов реально была выбрана —
      // host (напрямую), srflx (через STUN) или relay (через TURN), и по
      // какому протоколу. Если тут будет "relay" по UDP и звук/видео всё
      // равно не идут — дело не в NAT/файрволе, а в чём-то другом (кодеки,
      // сама передача треков); если пары кандидатов вообще нет годной —
      // дело в сетевой доступности/TURN.
      pc.getStats().then((stats) => {
        stats.forEach((r) => {
          if (r.type === 'candidate-pair' && r.state === 'succeeded') {
            const local = stats.get(r.localCandidateId);
            const remote = stats.get(r.remoteCandidateId);
            diag('выбранная пара кандидатов: локальный=', local && local.candidateType, local && local.protocol,
                 '| удалённый=', remote && remote.candidateType, remote && remote.protocol);
          }
        });
      }).catch(() => {});
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
  pc.onconnectionstatechange = () => diag('connectionState →', pc.connectionState);
  pc.onsignalingstatechange = () => diag('signalingState →', pc.signalingState);

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
  // и нет — это уже не "врёт статус", а видно по факту в диагностике, и
  // делается попытка restartIce(), плюс пользователю честно показывается
  // "Проблемы со связью…" вместо тикающего таймера над чёрным экраном.
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
      if (!watchdogSawMedia) { watchdogSawMedia = true; diag('media watchdog: реальные RTP-данные пошли (bytesReceived > 0)'); }
      if (state.callMediaStuck) { state.callMediaStuck = false; diag('media watchdog: медиа восстановилось'); }
      return;
    }
    // Даём звонку ~7 секунд (примерно 3-4 тика) на настоящее соединение,
    // прежде чем бить тревогу — это дольше, чем обычно занимает ICE по
    // прямому/STUN пути, но не настолько долго, чтобы человек решил, что
    // приложение просто зависло.
    if (!watchdogSawMedia && watchdogTicks >= 3) {
      if (!state.callMediaStuck) {
        state.callMediaStuck = true;
        diag('media watchdog: спустя', watchdogTicks * 2.5, 'с всё ещё 0 байт входящего медиа при iceConnectionState=', pc.iceConnectionState, ', connectionState=', pc.connectionState, '— пробуем restartIce()');
      }
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
  callDiag('startCall (я звоню): добавлено дорожек в pc =', pc.getSenders().length);
  attachPeerConnectionHandlers(pc);
  showCallOverlay(conv.peer, kind, true);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  callDiag('offer создан, m-line(ы):', (offer.sdp.match(/^m=.*/gm) || []).join(' | '));
  state.ws.send(JSON.stringify({ type: 'call-offer', to: state.currentCallPeerId, sdp: offer, kind, callId: state.currentCallId }));
}

function genCallId() {
  return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('call_' + Date.now() + '_' + Math.random().toString(36).slice(2));
}

function handleCallSignal(msg) {
  if (msg.type === 'call-offer') {
    // если уже идёт другой звонок — просто отклоняем новый, чтобы не путать состояние
    if (state.currentCallPeerId || !$('#callOverlay').classList.contains('hidden')) {
      state.ws.send(JSON.stringify({ type: 'call-decline', to: msg.from }));
      return;
    }
    pendingOffer = msg;
    const peerUser = findKnownUser(msg.from);
    const name = peerUser ? peerUser.displayName : 'Неизвестный';
    $('#incomingPeerName').textContent = name;
    $('#incomingText').textContent = `Входящий ${msg.kind === 'video' ? 'видео' : 'аудио'}звонок…`;
    const av = $('#incomingAvatarBig');
    av.textContent = peerUser && peerUser.avatar ? '' : initials(name);
    av.style.cssText = peerUser ? avatarStyle(peerUser) : '';
    if (!peerUser) {
      ensureUserCached(msg.from).then((u) => {
        if (!u || pendingOffer !== msg) return;
        $('#incomingPeerName').textContent = u.displayName;
        av.textContent = u.avatar ? '' : initials(u.displayName);
        av.style.cssText = avatarStyle(u);
      });
    }
    showModal('#incomingCall');
    notifyIncomingCall(msg);
    startRingtone();
  } else if (msg.type === 'call-answer') {
    stopRingback(); // дозвонились — гудки больше не нужны
    if (state.peerConn) {
      state.peerConn.setRemoteDescription(new RTCSessionDescription(msg.sdp)).then(flushPendingCallIce).catch(() => {});
    }
    $('#callStatus').textContent = 'Соединено';
    startCallTimer();
    syncMediaStateToPeer();
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
  $('#remoteVideo').classList.toggle('hidden', !state.remoteCamOn);
  $('#callAvatarBig').classList.toggle('hidden', !!state.remoteCamOn);
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
  callDiag('acceptIncomingCall (мне звонят): добавлено дорожек в pc =', pc.getSenders().length,
           '| входящий offer m-line(ы):', (pendingOffer.sdp.sdp.match(/^m=.*/gm) || []).join(' | '));
  attachPeerConnectionHandlers(pc);
  await pc.setRemoteDescription(new RTCSessionDescription(pendingOffer.sdp));
  flushPendingCallIce();
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  callDiag('answer создан, m-line(ы):', (answer.sdp.match(/^m=.*/gm) || []).join(' | '));
  state.ws.send(JSON.stringify({ type: 'call-answer', to: state.currentCallPeerId, sdp: answer, callId: state.currentCallId }));
  const peerUser = findKnownUser(pendingOffer.from);
  showCallOverlay(peerUser || { displayName: 'Собеседник' }, pendingOffer.kind, false);
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

function showCallOverlay(peerUser, kind, outgoing) {
  // Гудки вызова — только у того, кто звонит (outgoing). У того, кому
  // звонят, играет рингтон — он запускается отдельно, в handleCallSignal
  // при получении call-offer, ещё до того, как этот экран вообще открыт
  // (человек сначала видит/слышит входящий звонок и только потом решает
  // принять — тогда этот экран и появится).
  if (outgoing) startRingback();
  const name = peerUser.displayName || 'Собеседник';
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
    if (!moved) swapPipVideos();
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
  const nextFacing = groupCall.facingMode === 'environment' ? 'user' : 'environment';
  try {
    const newStream = await getMedia({ video: { facingMode: nextFacing }, audio: false }, { silent: true });
    const newTrack = newStream.getVideoTracks()[0];
    if (!newTrack) return;
    newTrack.enabled = groupCall.camOn;
    groupCall.pcs.forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(newTrack);
    });
    groupCall.localStream.removeTrack(oldTrack);
    oldTrack.stop();
    groupCall.localStream.addTrack(newTrack);
    groupCall.facingMode = nextFacing;
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
  });
});

async function openAdminPanel() {
  await Promise.all([renderAdminUsers(), renderAdminChats(), renderAdminApk(), renderAdminBanner()]);
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
    const premiumActive = isPremiumActive(u);
    const premiumStatusHtml = premiumActive
      ? `<span class="premium-status-tag">⭐ Premium ${u.premiumUntil ? 'до ' + fmtDate(u.premiumUntil) : '(навсегда)'}</span>`
      : '';
    const premiumControlsHtml = u.isBot ? '' : premiumActive
      ? `<button class="btn-secondary" data-premium-revoke="${u.id}">Забрать Premium</button>`
      : `<select class="premium-months-select" data-premium-select="${u.id}">
           <option value="1">Premium: 1 мес</option>
           <option value="3">Premium: 3 мес</option>
           <option value="6">Premium: 6 мес</option>
           <option value="12">Premium: 12 мес</option>
         </select>
         <button class="btn-secondary" data-premium-grant="${u.id}">⭐ Выдать</button>
         <button class="btn-secondary" data-premium-lifetime="${u.id}">Навсегда</button>`;
    row.innerHTML = `
      <div class="avatar${avatarRingClass(u)}" style="${u.avatar ? avatarStyle(u) : ''}">${u.avatar ? '' : initials(u.displayName)}</div>
      <div class="grow">
        <div class="name">${escapeHtml(u.displayName)}${verifiedBadge(u)}${premiumBadge(u)} ${u.isAdmin ? '<span class="admin-badge">admin</span>' : ''} ${u.isBot ? '🤖' : ''}</div>
        <div class="sub">@${escapeHtml(u.username)} ${premiumStatusHtml}</div>
        ${premiumControlsHtml ? `<div class="admin-premium-controls">${premiumControlsHtml}</div>` : ''}
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
  el.querySelectorAll('[data-premium-grant]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.premiumGrant;
      const select = el.querySelector(`[data-premium-select="${id}"]`);
      const months = select ? select.value : 1;
      try {
        await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { premiumAction: 'grant', premiumMonths: months } });
        renderAdminUsers();
      } catch (err) { alert(err.message); }
    });
  });
  el.querySelectorAll('[data-premium-lifetime]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.premiumLifetime;
      if (!confirm('Выдать безлимитную Asteria Premium (без срока действия)?')) return;
      try {
        await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { premiumAction: 'lifetime' } });
        renderAdminUsers();
      } catch (err) { alert(err.message); }
    });
  });
  el.querySelectorAll('[data-premium-revoke]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.premiumRevoke;
      try {
        await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { premiumAction: 'revoke' } });
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
        <div class="name">${escapeHtml(c.title || c.name)}${canVerify ? verifiedBadge(c) : ''} ${c.type === 'channel' ? '📢' : c.type === 'group' ? '👥' : ''}</div>
        <div class="sub">${c.messageCount} сообщений</div>
      </div>
      ${canVerify ? `<button class="btn-secondary" data-verify-conv="${c.id}">${c.isVerified ? 'Снять галочку' : '✔️ Верифицировать'}</button>` : ''}
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

