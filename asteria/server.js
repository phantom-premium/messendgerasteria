'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

const db = require('./lib/db');
const { WSServer } = require('./lib/minirt-ws');
const { genId, hashPassword, verifyPassword, parseCookies, serializeCookie, encryptSecret, decryptSecret, encryptMessageText, decryptMessageText, conversationKeyFingerprint } = require('./lib/util');
const { createTurnServer, generateTurnCredentials } = require('./lib/mini-turn');

// ФИКС: 31.07 сервер полностью упал ("UNIQUE constraint failed: calls.id")
// и отключил вообще всех пользователей до ручного перезапуска — потому что
// это простой Node-процесс без каких-либо обёрток, и ЛЮБОЕ необработанное
// исключение где угодно в коде убивает его целиком. Основная причина уже
// исправлена точечно (см. handleWSMessage), а это — последняя линия
// обороны на будущее: если где-то ещё (HTTP-запрос, таймер и т.п.)
// вылетит непойманная ошибка, сервер теперь её залогирует и продолжит
// работать, а не рухнет для всех сразу.
process.on('uncaughtException', (err) => {
  console.error('🔥 Необработанное исключение (сервер продолжает работу):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('🔥 Необработанный отказ промиса (сервер продолжает работу):', reason);
});

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Уникальная метка текущего запуска сервера. Нужна клиенту, чтобы понять,
// что он выполняется на устаревшей версии JS/CSS/HTML (см. /api/web/build
// и checkBuildFreshness() в app.js). Актуально для iOS: приложение,
// добавленное на экран "Домой", при повторном открытии часто не
// перезагружает страницу заново, а "размораживает" старую вкладку из
// памяти — если сервер тем временем обновился, старый JS начинает
// работать с новым бэкендом и разваливается на вид. Т.к. метка берётся
// один раз при старте процесса, любой рестарт/деплой автоматически даёт
// новое значение.
const BUILD_ID = String(Date.now());
// Тот же постоянный "внешний" каталог, что и в lib/db.js — переживает
// обновление версии, т.к. лежит вне папки проекта (по умолчанию в домашней
// директории пользователя). См. ASTERIA_DATA_DIR для переопределения.
const PERSIST_ROOT = process.env.ASTERIA_DATA_DIR || path.join(os.homedir(), '.asteria-data');
const UPLOADS_DIR = process.env.ASTERIA_UPLOADS_DIR || path.join(PERSIST_ROOT, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Та же одноразовая миграция, что и для базы данных: если раньше загруженные
// файлы лежали внутри asteria/uploads, а на новом постоянном месте их ещё
// нет — переносим один раз, чтобы не потерять уже загруженные аватарки,
// сторис и обои.
const LEGACY_UPLOADS_DIR = path.join(__dirname, 'uploads');
if (LEGACY_UPLOADS_DIR !== UPLOADS_DIR && fs.existsSync(LEGACY_UPLOADS_DIR)
    && fs.readdirSync(UPLOADS_DIR).length === 0) {
  fs.cpSync(LEGACY_UPLOADS_DIR, UPLOADS_DIR, { recursive: true });
  console.log('📦 Загруженные файлы перенесены из старого расположения в', UPLOADS_DIR);
}
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 дней

// ---------- Обновление Android-приложения через админ-панель ----------
// Раньше при каждой новой версии нужно было вручную ходить к каждому
// пользователю и переустанавливать APK. Теперь админ загружает новый APK
// через панель, а сами приложения на телефонах сверяют номер версии при
// запуске и предлагают пользователю обновиться сами — вручную обходить
// никого не нужно. Метаданные и сам файл лежат в PERSIST_ROOT (переживают
// обновление кода сервера), а не в папке проекта.
const APP_RELEASE_DIR = path.join(PERSIST_ROOT, 'app-release');
const APP_RELEASE_META_PATH = path.join(APP_RELEASE_DIR, 'release.json');
const APP_RELEASE_APK_PATH = path.join(APP_RELEASE_DIR, 'app.apk');
const APP_RELEASE_MAX_BYTES = 200 * 1024 * 1024; // 200 МБ с запасом — APK-обёртка вокруг WebView обычно весит единицы-десятки МБ

function readAppReleaseMeta() {
  try {
    return JSON.parse(fs.readFileSync(APP_RELEASE_META_PATH, 'utf8'));
  } catch (e) {
    return null;
  }
}

// Уведомляет ВСЕХ прямо сейчас подключённых (и веб-вкладки, и фоновый
// Android push-сервис — см. AsteriaPushService.handleServerEvent) о новой
// версии приложения. Кто именно должен отреагировать — решает уже сам
// клиент, сравнивая versionCode со своим (у веб-версии такого понятия нет,
// событие для неё просто не имеет смысла и игнорируется).
function broadcastAppUpdateAvailable(meta) {
  const payload = {
    type: 'app-update-available',
    versionCode: meta.versionCode,
    versionName: meta.versionName,
    notes: meta.notes || '',
    url: '/api/app/download',
  };
  socketsByUser.forEach((set) => set.forEach((c) => c.send(payload)));
}

// ---------- Баннер на главной странице (админ-панель → "Баннер") ----------
// Показывается в блоке с папками чатов (сразу под ними). Каждый
// пользователь может закрыть его крестиком — закрытие запоминается лично
// для него (поле users.dismissedBannerId), не влияет на остальных, и не
// мешает увидеть баннер снова, если админ опубликует новый (см. id ниже).
const BANNER_PATH = path.join(PERSIST_ROOT, 'banner.json');

function readBanner() {
  try {
    return JSON.parse(fs.readFileSync(BANNER_PATH, 'utf8'));
  } catch (e) {
    return null;
  }
}

// Безопасно превращает "/uploads/..." URL в реальный путь на диске, не
// позволяя выйти за пределы UPLOADS_DIR (защита от path traversal вида
// "/uploads/../../etc/passwd"). Возвращает null, если URL не похож на
// загруженный файл или путь оказался вне разрешённой папки.
function resolveUploadPath(mediaUrl) {
  const u = String(mediaUrl || '');
  if (!u.startsWith('/uploads/')) return null;
  const relPath = u.slice('/uploads/'.length);
  const resolvedPath = path.resolve(path.join(UPLOADS_DIR, relPath));
  const resolvedRoot = path.resolve(UPLOADS_DIR) + path.sep;
  if (!resolvedPath.startsWith(resolvedRoot)) return null;
  return resolvedPath;
}

// Удаляет загруженный файл по его "/uploads/..." URL, если он там есть.
// Best-effort: любая ошибка (файла уже нет, нет прав и т.п.) просто
// логируется и не мешает основной операции (например, удалению сообщения).
function deleteUploadedFile(mediaUrl) {
  const resolvedPath = resolveUploadPath(mediaUrl);
  if (!resolvedPath) return;
  fs.unlink(resolvedPath, (err) => {
    if (err && err.code !== 'ENOENT') {
      console.error('⚠️  Не удалось удалить файл', mediaUrl, ':', err.message);
    }
  });
}

// ---------- Бот ----------
// bot_asteria — системный бот "Цифровой ID" (@idbot), цифровой ID
// пользователя внутри Asteria (раньше был просто ботом-помощником
// "Asteria Bot" — id намеренно не меняем, иначе у всех пользователей
// "потерялась" бы личная переписка с ним; меняем только видимые поля и
// добавляем запись в таблицу bots, чтобы у него появилось собственное
// мини-приложение).
const BOT_ID = 'bot_asteria';
const BOT_USERNAME = 'idbot';
const ADMIN_COMMAND = '/openadmin89778958103';
const RIVEO_AVATAR = '/assets/riveo-logo.png';
function ensureBotUser() {
  const existing = db.findById('users', BOT_ID);
  if (!existing) {
    db.insert('users', {
      id: BOT_ID,
      username: BOT_USERNAME,
      displayName: 'Цифровой ID',
      passwordHash: null,
      isBot: true,
      avatar: RIVEO_AVATAR,
      status: 'Цифровой ID · системный бот',
      createdAt: Date.now(),
    });
  } else if (existing.username !== BOT_USERNAME || existing.displayName !== 'Цифровой ID') {
    // Миграция для уже развёрнутых серверов, где этот бот ещё называется
    // по-старому (логин "asteria_bot"/"riveo") — id и вся история переписки
    // сохраняются, обновляется только логин/бренд.
    db.update('users', BOT_ID, {
      username: BOT_USERNAME,
      displayName: 'Цифровой ID',
      avatar: RIVEO_AVATAR,
      status: 'Цифровой ID · системный бот',
    });
  }
  // Запись в таблице bots — только ради мини-приложения (см. enrichConversation:
  // кнопка мини-аппа у поля ввода появляется, если у собеседника-бота есть
  // такая запись с miniApp.enabled). Сам бот системный (isSystem), его нельзя
  // ни удалить, ни "усыновить" через BotCreator.
  const botRow = db.findById('bots', BOT_ID);
  if (!botRow) {
    db.insert('bots', {
      id: BOT_ID,
      ownerId: null,
      username: BOT_USERNAME,
      displayName: 'Цифровой ID',
      isSystem: true,
      commands: [],
      miniApp: { enabled: true, url: '/miniapps/riveo.html' },
      createdAt: Date.now(),
    });
  } else if (botRow.username !== BOT_USERNAME || botRow.displayName !== 'Цифровой ID') {
    db.update('bots', BOT_ID, { username: BOT_USERNAME, displayName: 'Цифровой ID' });
  }
}
ensureBotUser();

// ---------- Riveo ID: паспорт и банковская карта, привязанные к боту ----------
// Хранилище — отдельная таблица riveoProfiles (id = userId, один профиль на
// пользователя). Каждый блок (passport/card) состоит из:
//   - encrypted — ВЕСЬ набор введённых полей целиком, зашифрованный
//     AES-256-GCM (см. encryptSecret/decryptSecret в lib/util.js). Наружу
//     (в API/боту/админке) эта строка никогда не отдаётся.
//   - preview — маленький маскированный "предпросмотр" (последние 4 цифры,
//     срок действия и т.п.), который и показывается пользователю и боту.
// Так же устроены обычные платёжные сервисы: после привязки карты полный
// номер уже нигде не возвращается, только маска — этим и объясняется,
// почему в API ниже нет "получить данные обратно в открытом виде": он
// нарочно не нужен, а его отсутствие снижает ущерб от возможной утечки
// сессии/токена. CVV не запрашивается и не хранится вообще — ни в каком
// виде: он не нужен для того, чтобы предъявить/подтвердить владение картой
// внутри мессенджера, а хранить его — прямое нарушение стандартов PCI DSS.
function luhnValid(digits) {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return digits.length > 0 && sum % 10 === 0;
}
function cardBrand(digits) {
  if (/^4/.test(digits)) return 'Visa';
  if (/^(5[1-5]|2[2-7])/.test(digits)) return 'Mastercard';
  if (/^220[0-4]/.test(digits)) return 'Мир';
  return 'Карта';
}
function maskLast4(digits) {
  return '•• •• •• ' + digits.slice(-4);
}
function getRiveoProfile(userId) {
  return db.findById('riveoProfiles', userId);
}
function riveoPreview(userId) {
  const p = getRiveoProfile(userId);
  return {
    passport: (p && p.passport) ? p.passport.preview : null,
    card: (p && p.card) ? p.card.preview : null,
  };
}
function saveRiveoPassport(userId, body) {
  const fullName = String((body && body.fullName) || '').trim().slice(0, 120);
  const birthDate = String((body && body.birthDate) || '').trim().slice(0, 20);
  const series = String((body && body.series) || '').trim().slice(0, 20);
  const number = String((body && body.number) || '').trim().slice(0, 20);
  const issuedBy = String((body && body.issuedBy) || '').trim().slice(0, 200);
  const issueDate = String((body && body.issueDate) || '').trim().slice(0, 20);
  const departmentCode = String((body && body.departmentCode) || '').trim().slice(0, 20);
  const address = String((body && body.address) || '').trim().slice(0, 300);
  if (!fullName || !series || !number) return { error: 'Укажите ФИО, серию и номер документа' };
  const digitsOnly = (series + number).replace(/\D/g, '');
  const record = { fullName, birthDate, series, number, issuedBy, issueDate, departmentCode, address };
  const preview = {
    fullName,
    birthDate,
    numberMasked: digitsOnly.length >= 4 ? maskLast4(digitsOnly) : '••••',
    updatedAt: Date.now(),
  };
  const field = { encrypted: encryptSecret(record), preview, updatedAt: Date.now() };
  if (getRiveoProfile(userId)) {
    db.update('riveoProfiles', userId, { passport: field });
  } else {
    db.insert('riveoProfiles', { id: userId, userId, passport: field, card: null, createdAt: Date.now() });
  }
  return { preview };
}
function saveRiveoCard(userId, body) {
  const holder = String((body && body.holder) || '').trim().slice(0, 80);
  const number = String((body && body.number) || '').replace(/\D/g, '').slice(0, 19);
  const expiry = String((body && body.expiry) || '').trim().slice(0, 7);
  if (!holder || number.length < 12 || number.length > 19) return { error: 'Проверьте имя держателя и номер карты' };
  if (!luhnValid(number)) return { error: 'Похоже, номер карты введён с ошибкой' };
  if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(expiry)) return { error: 'Срок действия — в формате ММ/ГГ' };
  const record = { holder, number, expiry };
  const preview = { holder, brand: cardBrand(number), last4: number.slice(-4), expiry, updatedAt: Date.now() };
  const field = { encrypted: encryptSecret(record), preview, updatedAt: Date.now() };
  if (getRiveoProfile(userId)) {
    db.update('riveoProfiles', userId, { card: field });
  } else {
    db.insert('riveoProfiles', { id: userId, userId, passport: null, card: field, createdAt: Date.now() });
  }
  return { preview };
}
function deleteRiveoPassport(userId) {
  if (getRiveoProfile(userId)) db.update('riveoProfiles', userId, { passport: null });
}
function deleteRiveoCard(userId) {
  if (getRiveoProfile(userId)) db.update('riveoProfiles', userId, { card: null });
}

function botReply(user, text) {
  const raw = (text || '').trim();
  const t = raw.toLowerCase();
  if (t === '/help' || t === 'помощь' || t === '/start') {
    return '\u{1F5DD}\uFE0F Я Цифровой ID — ваш ID в Asteria.\n\nЧерез моё мини-приложение (кнопка рядом с полем ввода) можно привязать паспортные данные и банковскую карту — они хранятся в зашифрованном виде, а показываются только в маскированном.\n\nКоманды:\n/status — что у меня сохранено\n/delete passport — удалить паспортные данные\n/delete card — удалить данные карты\n/time — текущее время сервера';
  }
  if (t === '/time') return 'Серверное время: ' + new Date().toLocaleString('ru-RU');
  if (t === '/status') {
    const { passport, card } = riveoPreview(user.id);
    const lines = [];
    lines.push(passport ? `📄 Паспорт: ${passport.fullName}, № ${passport.numberMasked}` : '📄 Паспорт: не привязан');
    lines.push(card ? `💳 Карта: ${card.brand} •••• ${card.last4}, действует до ${card.expiry}` : '💳 Карта: не привязана');
    return lines.join('\n');
  }
  if (t === '/delete passport') {
    deleteRiveoPassport(user.id);
    return 'Паспортные данные удалены.';
  }
  if (t === '/delete card') {
    deleteRiveoCard(user.id);
    return 'Данные карты удалены.';
  }
  return 'Не знаю такой команды. Напиши /help';
}

// ---------- BotCreator: платформа, позволяющая любому пользователю
// создать своего бота, задать ему команды и подключить мини-приложение
// (переключатель + ссылка настраиваются в собственном мини-приложении
// BotCreator — public/miniapps/botcreator.html). ----------
const BOTCREATOR_ID = 'bot_creator';
const RESERVED_USERNAMES = new Set(['asteria_bot', 'riveo', 'idbot', 'botcreator', 'admin', 'support', 'asteria']);
const botWizard = new Map(); // userId -> { step: 'name' | 'username', name }

function ensureBotCreatorUser() {
  const users = db.all('users');
  if (!users.find((u) => u.id === BOTCREATOR_ID)) {
    db.insert('users', {
      id: BOTCREATOR_ID,
      username: 'BotCreator',
      displayName: 'BotCreator',
      passwordHash: null,
      isBot: true,
      avatar: '',
      status: 'Создавайте своих ботов',
      createdAt: Date.now(),
    });
  }
  if (!db.findById('bots', BOTCREATOR_ID)) {
    db.insert('bots', {
      id: BOTCREATOR_ID,
      ownerId: null,
      username: 'BotCreator',
      displayName: 'BotCreator',
      isSystem: true,
      commands: [],
      miniApp: { enabled: true, url: '/miniapps/botcreator.html' },
      createdAt: Date.now(),
    });
  }
}
ensureBotCreatorUser();

function isValidBotUsername(uname) {
  return /^[a-zA-Z][a-zA-Z0-9_]{2,31}$/.test(uname) && /bot$/i.test(uname);
}
function publicBot(bot) {
  if (!bot) return null;
  const botUser = db.findById('users', bot.id);
  return {
    id: bot.id,
    username: bot.username,
    displayName: bot.displayName,
    avatar: (botUser && botUser.avatar) || '',
    status: (botUser && botUser.status) || '',
    ownerId: bot.ownerId,
    isVerified: !!(botUser && botUser.isVerified),
    hasMiniApp: !!(bot.miniApp && bot.miniApp.enabled && bot.miniApp.url),
  };
}

function isBotUsernameTaken(uname) {
  return RESERVED_USERNAMES.has(uname.toLowerCase())
    || !!db.findOneBy('users', 'username', uname)
    || !!db.findOneBy('bots', 'username', uname);
}

function createUserBot(ownerId, name, uname) {
  const botId = genId('bot');
  db.insert('users', {
    id: botId,
    username: uname,
    displayName: name,
    passwordHash: null,
    isBot: true,
    isCustomBot: true,
    ownerId,
    avatar: '',
    status: 'Бот · создан в BotCreator',
    createdAt: Date.now(),
  });
  const bot = db.insert('bots', {
    id: botId,
    ownerId,
    username: uname,
    displayName: name,
    commands: [],
    miniApp: { enabled: false, url: '' },
    token: genId('tok'),
    createdAt: Date.now(),
  });
  return bot;
}

function botCreatorReply(user, text) {
  const raw = (text || '').trim();
  const t = raw.toLowerCase();
  const wiz = botWizard.get(user.id);

  if (t === '/cancel' && wiz) {
    botWizard.delete(user.id);
    return 'Создание бота отменено.';
  }

  if (wiz) {
    if (wiz.step === 'name') {
      const name = raw.slice(0, 64);
      if (!name) return 'Имя бота не может быть пустым. Введите имя ещё раз (или /cancel).';
      wiz.name = name;
      wiz.step = 'username';
      return 'Отлично! Теперь придумайте логин бота — латиницей, цифрами и подчёркиванием (3–32 символа), обязательно оканчивается на «bot» (например: my_shop_bot).';
    }
    if (wiz.step === 'username') {
      const uname = raw.replace(/^@/, '');
      if (!isValidBotUsername(uname)) {
        return 'Логин должен быть латиницей/цифрами/подчёркиванием (3–32 симв.) и заканчиваться на «bot». Попробуйте ещё раз (или /cancel).';
      }
      if (isBotUsernameTaken(uname)) {
        return 'Этот логин уже занят, придумайте другой (или /cancel).';
      }
      const bot = createUserBot(user.id, wiz.name, uname);
      botWizard.delete(user.id);
      return `🎉 Готово! Бот «${bot.displayName}» (@${bot.username}) создан и уже в списке ваших чатов.\n\nОткройте моё мини-приложение (синяя кнопка рядом с полем ввода в этом чате) — там можно задать команды бота и подключить ему собственное мини-приложение (переключатель + ссылка).`;
    }
  }

  if (t === '/start' || t === '/help') {
    return 'Я BotCreator \u{1F916} — здесь вы можете создавать собственных ботов.\n\n/newbot — создать нового бота\n/mybots — список ваших ботов\n\nПосле создания откройте моё мини-приложение (кнопка рядом с полем ввода) — там настраиваются команды бота и его собственное мини-приложение.';
  }
  if (t === '/newbot') {
    botWizard.set(user.id, { step: 'name' });
    return 'Как назвать бота? Это имя увидят пользователи.';
  }
  if (t === '/mybots') {
    const mine = db.findManyBy('bots', 'ownerId', user.id);
    if (!mine.length) return 'У вас пока нет ботов. Отправьте /newbot, чтобы создать первого.';
    return 'Ваши боты:\n' + mine.map((b) => `@${b.username} — ${b.displayName}`).join('\n');
  }
  return 'Не понимаю эту команду. Напишите /help.';
}

function customBotReply(botRecord, text) {
  const t = (text || '').trim();
  const tl = t.toLowerCase();
  const commands = botRecord.commands || [];
  if (tl === '/start' || tl === '/help') {
    if (commands.length) {
      return `Привет! Я ${botRecord.displayName}.\nДоступные команды:\n` + commands.map((c) => c.trigger).join('\n');
    }
    return `Привет! Я ${botRecord.displayName}. Мой создатель пока не настроил мои команды.`;
  }
  const cmd = commands.find((c) => c.trigger && c.trigger.toLowerCase() === tl);
  if (cmd) return cmd.response || '…';
  return 'Не знаю такой команды. Напишите /help.';
}

// IP клиента — с учётом реверс-прокси (X-Forwarded-For), если сервер стоит
// за ним; иначе берём адрес сокета напрямую.
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

// ---------- Вход по QR-коду ----------
// Тикеты живут в памяти (не в БД) — они короткоживущие (пара минут), и
// потеря нескольких "в процессе" тикетов при перезапуске сервера ничем не
// грозит (пользователь просто откроет вкладку с QR заново).
//
// Поток:
// 1. Новое устройство (не авторизовано) — POST /api/qr-login/create,
//    получает ticketId, рисует его в QR-код и начинает опрашивать статус.
// 2. Пользователь сканирует этот QR камерой ДРУГОГО, уже авторизованного
//    устройства (обычной камерой телефона — она сама откроет ссылку
//    /qr/<ticketId> в браузере) либо вводит код вручную в
//    Настройки → Устройства → "Подтвердить вход по коду".
// 3. На авторизованном устройстве это дёргает POST /api/qr-login/:id/confirm
//    — тикет помечается подтверждённым для userId.
// 4. Новое устройство при очередном опросе видит confirmed и ТУТ ЖЕ, этим
//    же запросом, заводит себе настоящую сессию (с собственными
//    User-Agent/IP — это единственное место, где мы знаем эти данные именно
//    НОВОГО устройства) и возвращает cookie.
const qrTickets = new Map(); // ticketId -> { createdAt, expiresAt, status, userId }
const QR_TICKET_TTL_MS = 3 * 60 * 1000; // 3 минуты на сканирование

function sweepExpiredQrTickets() {
  const now = Date.now();
  for (const [id, t] of qrTickets) {
    if (now > t.expiresAt + 30_000) qrTickets.delete(id); // небольшой запас, чтобы poll успел отдать "expired" перед удалением
  }
}
setInterval(sweepExpiredQrTickets, 60 * 1000);

// ---------- Сессии ----------
// Как часто обновлять lastSeenAt у сессии — не на каждый запрос (это было
// бы лишней записью в БД на каждый чих), а не чаще раза в пару минут.
const SESSION_TOUCH_INTERVAL_MS = 2 * 60 * 1000;

function getSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['asteria_session'];
  if (!token) return null;
  const session = db.findById('sessions', token);
  if (!session) return null;
  const now = Date.now();
  if (!session.lastSeenAt || now - session.lastSeenAt > SESSION_TOUCH_INTERVAL_MS) {
    db.update('sessions', session.id, { lastSeenAt: now });
    session.lastSeenAt = now;
  }
  return session;
}

function getUserFromReq(req) {
  const session = getSession(req);
  if (!session) return null;
  const user = db.findById('users', session.userId);
  return sweepPremiumExpiry(user);
}

// Человекочитаемое название устройства/браузера по User-Agent — для списка
// "Устройства" в настройках. Не претендует на точность как полноценная
// UA-библиотека, просто узнаёт самые частые случаи.
function deviceLabelFromUA(userAgent) {
  const ua = String(userAgent || '');
  let platform = 'Неизвестное устройство';
  if (ua.includes('iPhone')) platform = 'iPhone';
  else if (ua.includes('iPad')) platform = 'iPad';
  else if (ua.includes('Android')) platform = 'Android';
  else if (ua.includes('Macintosh') || ua.includes('Mac OS X')) platform = 'Mac';
  else if (ua.includes('Windows')) platform = 'Windows';
  else if (ua.includes('Linux')) platform = 'Linux';

  let browser = 'Браузер';
  if (ua.includes('OkHttp')) browser = 'Приложение Asteria';
  else if (ua.includes('EdgA') || ua.includes('Edg/')) browser = 'Edge';
  else if (ua.includes('OPR/') || ua.includes('Opera')) browser = 'Opera';
  else if (ua.includes('YaBrowser')) browser = 'Яндекс.Браузер';
  else if (ua.includes('CriOS') || ua.includes('Chrome')) browser = 'Chrome';
  else if (ua.includes('FxiOS') || ua.includes('Firefox')) browser = 'Firefox';
  else if (ua.includes('Safari') && !ua.includes('Chrome')) browser = 'Safari';

  // "Домашние" веб-приложения (Add to Home Screen) технически используют
  // тот же движок Safari/Chrome, различить их по обычному User-Agent
  // нельзя — оставляем общее название браузера.
  if (ua.includes('OkHttp')) return browser; // "Приложение Asteria" самодостаточно
  return `${platform} · ${browser}`;
}

function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

// Как publicUser(), но добавляет поле online с учётом приватности: если у
// пользователя включён hideOnlineStatus (доступно только Premium — см.
// PATCH /api/me), для всех, кроме него самого, он всегда выглядит офлайн.
// Самому пользователю (viewerId === u.id) статус и сама настройка видны как
// есть — это нужно, например, для строки «в сети»/«не в сети» в его же
// профиле и для отображения переключателя в настройках.
function publicUserForViewer(u, viewerId) {
  const out = publicUser(u);
  if (!out) return out;
  const isSelf = u.id === viewerId;
  out.online = isSelf ? isOnline(u.id) : (isOnline(u.id) && !u.hideOnlineStatus);
  if (!isSelf) { delete out.hideOnlineStatus; delete out.hideReadStatus; }
  return out;
}

// ---------- Asteria Premium ----------
// Цена озвучивается пользователю только информационно (199 ₽/мес) — реальная
// оплата в этой сборке не подключена, подписка выдаётся ИСКЛЮЧИТЕЛЬНО через
// админ-панель (см. PATCH /api/admin/users/:id ниже).
const PREMIUM_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
// Загрузка файла целиком идёт одним JSON-запросом (base64), то есть на пике
// в памяти одновременно держится несколько копий файла (сырые байты +
// base64-строка + декодированный буфер) — примерно 3-4x от размера самого
// файла. На слабом сервере с 1 ГБ ОЗУ большой лимит увеличивает риск
// нехватки памяти при загрузке большого видео. Поэтому лимиты можно
// понизить переменными окружения, не трогая код:
//   ASTERIA_MAX_UPLOAD_MB=10 ASTERIA_MAX_PREMIUM_UPLOAD_MB=30 node server.js
const PREMIUM_MAX_UPLOAD_BYTES = (parseInt(process.env.ASTERIA_MAX_PREMIUM_UPLOAD_MB, 10) || 120) * 1024 * 1024;
const REGULAR_MAX_UPLOAD_BYTES = (parseInt(process.env.ASTERIA_MAX_UPLOAD_MB, 10) || 25) * 1024 * 1024;
const PREMIUM_ONLY_REACTIONS = new Set(['🤩', '🥳', '💯', '⚡', '🌟', '😍']);
const PREMIUM_ONLY_THEMES = new Set(['aurora', 'gold']);
const FREE_WALLPAPER_VALUES = new Set([
  "url('/wallpapers/free-tattoo.webp')",
  "url('/wallpapers/free-doodle-blue.jpeg')",
  "url('/wallpapers/free-space.jpeg')",
  "url('/wallpapers/free-pets-pink.jpeg')",
]);
const PREMIUM_STORY_TTL_MS = 48 * 60 * 60 * 1000; // истории Premium-автора живут 48ч
const REGULAR_STORY_TTL_MS = 24 * 60 * 60 * 1000;

// true, если подписка активна прямо сейчас (учитывает срок действия)
function isPremiumActive(u) {
  if (!u || !u.isPremium) return false;
  if (!u.premiumUntil) return true; // null/0 = бессрочная подписка
  return u.premiumUntil > Date.now();
}

// Отметки о прочтении конкретного чата: conv.reads — { userId: timestamp
// последнего прочтения }. Своя запись видна всегда (нужна для счётчика
// непрочитанных), а запись других участников скрывается, если у них включена
// Premium-настройка «Скрыть отметки о прочтении» — тогда для остальных их
// сообщения выглядят просто «отправленными», даже если человек их уже читал.
function visibleReadsFor(conv, viewerId) {
  const reads = (conv && conv.reads) || {};
  const out = {};
  Object.keys(reads).forEach((uid) => {
    if (uid === viewerId) { out[uid] = reads[uid]; return; }
    const u = db.findById('users', uid);
    if (u && u.hideReadStatus) return;
    out[uid] = reads[uid];
  });
  return out;
}

// Если подписка истекла по времени — тихо снимаем флаг в базе, чтобы
// админ-панель и бейджи не врали о статусе. Возвращает актуальный объект.
function sweepPremiumExpiry(u) {
  if (u && u.isPremium && u.premiumUntil && u.premiumUntil <= Date.now()) {
    return db.update('users', u.id, { isPremium: false, premiumUntil: null });
  }
  return u;
}

function requireAdmin(user, res) {
  if (!user || !user.isAdmin) {
    sendJSON(res, 403, { error: 'Требуются права администратора' });
    return false;
  }
  return true;
}

function removeConvFromAllFolders(convId) {
  db.all('folders').forEach((f) => {
    if ((f.convIds || []).includes(convId)) {
      db.update('folders', f.id, { convIds: f.convIds.filter((id) => id !== convId) });
    }
  });
}

// ---------- HTTP helpers ----------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, maxBytes = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    const onData = (c) => {
      size += c.length;
      if (size > maxBytes) {
        chunks = null; // отпускаем уже накопленное сразу, не дожидаясь общей уборки промиса
        req.removeListener('data', onData);
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => {
      if (!chunks) return; // уже отклонили выше по превышению размера
      const raw = Buffer.concat(chunks).toString('utf8');
      chunks = null; // массив кусков больше не нужен — освобождаем сразу, а не после JSON.parse
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, rootDir, urlPath) {
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(rootDir, safePath);
  if (!filePath.startsWith(rootDir)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    fs.readFile(filePath, (err2, data) => {
      if (err2) { res.writeHead(404); res.end('Not found'); return; }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': data.length });
      res.end(data);
    });
  });
}

// ---------- Conversations helpers ----------
function ensureDMExists(userAId, userBId) {
  const convs = db.all('conversations');
  let conv = convs.find(
    (c) => c.type === 'dm' && c.participants.includes(userAId) && c.participants.includes(userBId)
  );
  if (!conv) {
    conv = db.insert('conversations', {
      id: genId('conv'),
      type: 'dm',
      participants: [userAId, userBId],
      createdAt: Date.now(),
    });
  }
  return conv;
}

function userConversations(userId) {
  return db.all('conversations').filter((c) => {
    if (c.type === 'dm') return c.participants.includes(userId);
    if (c.type === 'channel' || c.type === 'group') return c.participants.includes(userId) || c.ownerId === userId;
    return false;
  });
}

// ---------- WebSocket state ----------
const wss = new WSServer();
const socketsByUser = new Map(); // userId -> Set<WSConnection> (ВСЕ соединения — и веб/WebView, и фоновый Android push-сервис; нужны для доставки сообщений/звонков)
const onlineUsers = new Set(); // userId -> реально показывается как "в сети" (см. markPresence)
const offlineGraceTimers = new Map(); // userId -> таймер отложенного ухода в офлайн
const groupCallRooms = new Map(); // conversationId -> Set<userId> (кто сейчас в групповом звонке)
const groupCallRecordIds = new Map(); // conversationId -> id текущей записи в calls (пока звонок идёт)

// ФИКС: "все, кто установил Android-приложение, теперь постоянно в сети, и
// статус мигает". Причина — фоновый AsteriaPushService держит своё
// собственное WS-соединение открытым специально ПОСТОЯННО (даже когда
// приложение свёрнуто/закрыто), иначе push-уведомления не будут приходить.
// Но раньше "в сети" считалось как "есть хоть один открытый сокет" — то есть
// это фоновое соединение само по себе делало пользователя вечно "онлайн",
// хотя человек может не открывать приложение днями. Такое соединение теперь
// помечается на этапе подключения (?client=push в URL, см. toWsUrl() в
// AsteriaPushService.java) и не участвует в статусе "в сети" — только в
// доставке сообщений/звонков, как и раньше.
function hasForegroundSocket(userId) {
  const set = socketsByUser.get(userId);
  if (!set) return false;
  for (const c of set) { if (!c.isPushOnly) return true; }
  return false;
}
function isOnline(userId) {
  return onlineUsers.has(userId);
}

// Мигание статуса возникало ещё и из-за того, что Android иногда на пару
// секунд рвёт даже "живое" соединение (переключение сети, доза энергосбережения)
// и сервис тут же переподключается — без задержки это выглядело как быстрый
// online->offline->online. Даём небольшую отсрочку перед тем, как реально
// показать "не в сети", чтобы короткие обрывы не были заметны собеседникам.
const OFFLINE_GRACE_MS = 8000;
function markPresence(userId) {
  const nowOnline = hasForegroundSocket(userId);
  if (nowOnline) {
    const t = offlineGraceTimers.get(userId);
    if (t) { clearTimeout(t); offlineGraceTimers.delete(userId); }
    if (!onlineUsers.has(userId)) {
      onlineUsers.add(userId);
      broadcastPresence(userId, true);
    }
    return;
  }
  if (onlineUsers.has(userId) && !offlineGraceTimers.has(userId)) {
    const timer = setTimeout(() => {
      offlineGraceTimers.delete(userId);
      if (!hasForegroundSocket(userId)) {
        onlineUsers.delete(userId);
        broadcastPresence(userId, false);
      }
    }, OFFLINE_GRACE_MS);
    offlineGraceTimers.set(userId, timer);
  }
}

function addSocket(userId, conn) {
  if (!socketsByUser.has(userId)) socketsByUser.set(userId, new Set());
  socketsByUser.get(userId).add(conn);
}
function removeSocket(userId, conn) {
  const set = socketsByUser.get(userId);
  if (set) { set.delete(conn); if (set.size === 0) socketsByUser.delete(userId); }
}
function sendToUser(userId, payload) {
  const set = socketsByUser.get(userId);
  if (!set) return;
  set.forEach((conn) => conn.send(payload));
}
function broadcastToConversation(conv, payload, exceptUserId) {
  const targets = (conv.type === 'channel' || conv.type === 'group') ? [...(conv.participants || []), conv.ownerId] : conv.participants;
  new Set(targets).forEach((uid) => {
    if (uid && uid !== exceptUserId) sendToUser(uid, payload);
  });
}

// Определяет, что это фоновое соединение push-сервиса (см. выше), а не
// обычная открытая вкладка/WebView с активным пользователем.
//
// ФИКС: "у кого приложение старой версии — горит в сети вечно". Маркер
// ?client=push появился только в НОВОЙ версии Android-приложения — те, кто
// ещё не обновил само приложение (не сервер, а именно .apk на телефоне),
// продолжали слать фоновое соединение без этого маркера, и оно снова
// засчитывалось как "в сети" навсегда. Чтобы не ждать, пока все обновят
// приложение, добавили запасной признак: фоновый сервис всегда ходит через
// библиотеку OkHttp (свой характерный User-Agent), а не через WebView, как
// настоящий открытый экран приложения — значит по User-Agent можно
// однозначно отличить фоновое соединение даже у старых версий, без
// необходимости их обновлять.
function isPushOnlyRequest(req) {
  try {
    const url = new URL(req.url, 'http://internal');
    if (url.searchParams.get('client') === 'push') return true;
  } catch (e) { /* игнорируем — просто не сработал маркер */ }
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  return ua.includes('okhttp');
}

// Короткое текстовое превью сообщения для push-уведомления (аналог
// previewText() на клиенте, но нам тут не нужны все её тонкости — только
// чтобы уведомление не было пустым для не-текстовых сообщений).
function pushPreviewText(message) {
  switch (message.msgType) {
    case 'image': return message.content || '📷 Фото';
    case 'video': return message.content || '🎬 Видео';
    case 'video_circle': return '⭕ Видео-сообщение';
    case 'voice': return '🎙 Голосовое сообщение';
    case 'music': return '🎵 Трек';
    case 'file': return '📄 Файл';
    case 'sticker': return '😊 Стикер';
    case 'poll': return '📊 ' + (message.content || 'Опрос');
    case 'location': return '📍 Геолокация';
    case 'album': return message.content || `🖼 Альбом (${(message.meta && message.meta.items && message.meta.items.length) || ''} фото/видео)`;
    default: return message.content || '';
  }
}

// Готовит заголовок и текст уведомления для сообщения. Раньше это нужно
// было только для FCM-push; теперь то же самое кладётся прямо в WS-payload
// каждого сообщения (см. поле notif ниже) — так нативный Android-сервис
// (asteria-android/.../AsteriaPushService.java), у которого нет доступа к
// списку разговоров и профилям, может показать корректное системное
// уведомление, не делая для этого лишних запросов к серверу.
function buildNotifPreview(conv, message) {
  const senderUser = db.findById('users', message.senderId);
  const title = conv.type === 'channel' ? `📢 ${conv.name || 'Канал'}`
    : conv.type === 'group' ? `👥 ${conv.name || 'Группа'}`
    : (senderUser ? senderUser.displayName : 'Asteria');
  return { title, body: pushPreviewText(message) };
}

// ---------- Шифрование текста сообщений ----------
// Поле messages.content хранится в БД зашифрованным (AES-256-GCM), причём
// КАЖДАЯ переписка шифруется своим собственным ключом, порождённым из id
// этой переписки (см. подробный комментарий у deriveConversationKey в
// lib/util.js) — это защищает переписку, если файл базы данных когда-нибудь
// скопируют/украдут с диска сервера, а компрометация ключа одного диалога
// не даёт прочитать остальные. Расшифровка нужна КАЖДЫЙ раз, когда сообщение
// читается из БД и показывается клиенту (история чата, последнее сообщение
// в списке чатов, закреплённое сообщение и т.д.) — на местах, где сообщение
// только что вставлено в этом же запросе, расшифровка не нужна: под рукой
// уже есть исходный незашифрованный текст, его и рассылаем (см. handleWSMessage).
// Это НЕ end-to-end шифрование (сервер знает ключи и должен уметь читать
// сообщения, чтобы, например, отвечали боты) — оно защищает только "данные
// на диске", а не от самого сервера.
function decryptMessage(msg) {
  if (!msg) return msg;
  const out = { ...msg, content: decryptMessageText(msg.conversationId, msg.content) };
  if (out.replyPreview) out.replyPreview = { ...out.replyPreview, content: decryptMessageText(msg.conversationId, out.replyPreview.content) };
  return out;
}
function decryptMessages(list) {
  return (list || []).map(decryptMessage);
}

wss.on('connection', (conn, req) => {
  const user = getUserFromReq(req);
  if (!user) { conn.close(); return; }
  conn.userId = user.id;
  conn.isPushOnly = isPushOnlyRequest(req);
  addSocket(user.id, conn);
  markPresence(user.id);
  resendRingingCallsTo(user.id, conn);
  const currentRelease = readAppReleaseMeta();
  if (currentRelease && currentRelease.enabled) {
    conn.send({
      type: 'app-update-available',
      versionCode: currentRelease.versionCode,
      versionName: currentRelease.versionName,
      notes: currentRelease.notes || '',
      url: '/api/app/download',
    });
  }

  conn.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    // ФИКС АВАРИЙНОГО ПАДЕНИЯ СЕРВЕРА: раньше любая необработанная ошибка
    // внутри handleWSMessage (например, дублирующийся id при вставке в БД,
    // как это произошло с "UNIQUE constraint failed: calls.id") приводила к
    // необработанному исключению — а поскольку это простой Node-сервер без
    // домен-обёрток, такое исключение убивало ВЕСЬ процесс целиком,
    // отключая сразу всех подключённых пользователей до ручного перезапуска.
    // Теперь одно кривое/неожиданное сообщение от одного клиента не может
    // обрушить сервис для всех остальных — ошибка просто логируется.
    try {
      handleWSMessage(user, conn, msg);
    } catch (err) {
      console.error('⚠️  Ошибка обработки WS-сообщения (сервер продолжает работу):', msg && msg.type, err);
    }
  });

  conn.on('close', () => {
    removeSocket(user.id, conn);
    markPresence(user.id);
    if (!socketsByUser.has(user.id)) {
      groupCallRooms.forEach((room, convId) => { if (room.has(user.id)) leaveGroupCall(convId, user.id); });
    }
  });
});

// ФИКС: "не вижу входящий звонок, если открыл приложение прямо во время
// звонка". Раньше call-offer уходил один раз, в момент звонка, только на
// сокеты, которые были открыты именно тогда. Если у получателя в этот
// момент приложение было закрыто, сигнал терялся безвозвратно — а когда
// человек открывал приложение (даже пока звонок всё ещё идёт), новый
// call-offer уже не приходил, потому что звонящий отправляет его только
// один раз, при старте звонка. Теперь при каждом новом подключении сокета
// сервер сам проверяет, нет ли для этого пользователя ещё звонящего вызова,
// и, если есть, повторно шлёт тот же call-offer (с тем же callId и SDP) —
// именно этому сокету, чтобы не задваивать звонок на уже открытых вкладках.
const RINGING_RESEND_MAX_AGE_MS = 45 * 1000;
function resendRingingCallsTo(userId, conn) {
  const now = Date.now();
  // ФИКС ПАМЯТИ/СКОРОСТИ: раньше здесь был db.all('calls') — это
  // выгружало в память ВСЮ историю звонков целиком, и делало это при
  // КАЖДОМ подключении сокета (то есть при каждом открытии приложения
  // каждым пользователем). На слабом сервере с растущей историей звонков
  // это заметно и по памяти, и по задержке коннекта. findManyBy использует
  // индекс по calleeId и сразу возвращает только звонки конкретного
  // пользователя — на порядки меньше данных.
  db.findManyBy('calls', 'calleeId', userId)
    .filter((c) => c.mode === '1:1' && c.status === 'ringing' && c.sdp && (now - c.startedAt) < RINGING_RESEND_MAX_AGE_MS)
    .forEach((c) => {
      const caller = db.findById('users', c.callerId);
      conn.send({
        type: 'call-offer',
        from: c.callerId,
        to: userId,
        sdp: c.sdp,
        kind: c.kind,
        callId: c.id,
        callerName: caller ? caller.displayName : undefined,
        callerAvatar: caller ? (caller.avatar || null) : null,
      });
    });
}

function broadcastPresence(userId, online) {
  // Приватность: если пользователь включил hideOnlineStatus (Premium),
  // событие о его входе/выходе не рассылаем вообще — для всех остальных он
  // как был «не в сети», так и остаётся, независимо от реального статуса.
  const target = db.findById('users', userId);
  if (target && target.hideOnlineStatus) return;
  const payload = { type: 'presence', userId, online, at: Date.now() };
  socketsByUser.forEach((set) => set.forEach((c) => c.send(payload)));
}

function handleWSMessage(user, conn, msg) {
  if (!msg || !msg.type) return;

  if (msg.type === 'client-log') {
    // Диагностика звонков ([CALL-DIAG] в app.js) — пробрасываем прямо в
    // терминал сервера, потому что не у всех есть Mac для удалённой
    // консоли iOS Safari, а серверный терминал и так уже под рукой у
    // администратора. Строго текст, без исполнения — просто console.log.
    console.log(`📱 [${user.username}]`, String(msg.text || '').slice(0, 2000));
    return;
  }

  if (msg.type === 'message') {
    const conv = db.findById('conversations', msg.conversationId);
    if (!conv) return;
    const isMember = conv.type === 'dm' ? conv.participants.includes(user.id) :
      (conv.participants.includes(user.id) || conv.ownerId === user.id);
    if (!isMember) return;
    // Каналы — всегда только вещание: писать может владелец или админ сайта,
    // остальные только читают/реагируют. Группы — обычный групповой чат,
    // писать может любой участник (это и есть разница между ними).
    if (conv.type === 'channel' && conv.ownerId !== user.id && !user.isAdmin) return;

    // Ответ на сообщение: сохраняем сам id + компактный снимок оригинала
    // (имя автора, тип, короткий текст) прямо в сообщении — чтобы цитату
    // можно было показать в бабле сразу, без похода за исходным сообщением,
    // и чтобы цитата не потерялась, если оригинал позже удалят.
    let replyToId = null;
    let replyPreview = null;
    if (msg.replyToId) {
      const original = db.findById('messages', msg.replyToId);
      if (original && original.conversationId === conv.id) {
        replyToId = original.id;
        const originalSender = db.findById('users', original.senderId);
        replyPreview = {
          id: original.id,
          senderId: original.senderId,
          senderName: originalSender ? originalSender.displayName : 'Пользователь',
          msgType: original.msgType,
          content: decryptMessageText(conv.id, original.content).slice(0, 200),
        };
      }
    }

    let meta = msg.meta || null;
    let content = msg.content || '';
    if (msg.msgType === 'poll') {
      const rawOptions = Array.isArray(meta && meta.options) ? meta.options : [];
      const options = rawOptions
        .map((o, i) => ({ id: 'opt' + i, text: String((o && o.text) || '').trim().slice(0, 120) }))
        .filter((o) => o.text)
        .slice(0, 12);
      if (options.length < 2) return; // опросу нужно минимум 2 варианта
      const question = String(content || (meta && meta.question) || '').trim().slice(0, 300);
      if (!question) return;
      const maxChoices = Math.max(1, Math.min(options.length, parseInt(meta && meta.maxChoices, 10) || 1));
      meta = { question, options, maxChoices, votes: {} };
      content = question;
    } else if (msg.msgType === 'location') {
      // Геолокация: координаты приходят от клиента, поэтому нельзя доверять
      // им как есть — meta мог бы содержать что угодно (в т.ч. вредоносную
      // строку), а мы потом подставляем её в src картинки/ссылку у ВСЕХ
      // участников чата. Принимаем только конечные числа в допустимом
      // диапазоне, всё остальное отбрасываем вместе с сообщением.
      const lat = Number(meta && meta.lat);
      const lng = Number(meta && meta.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
      meta = { lat, lng };
      content = '';
    } else if (msg.msgType === 'voice' || msg.msgType === 'video_circle') {
      // transcript — текст, который клиент сам распознал во время записи
      // (см. startLiveTranscription в app.js) и прислал вместе с сообщением.
      // Сервер тут ничего не распознаёт и никуда не ходит — просто хранит
      // присланную строку как есть, но не доверяет её длине/типу.
      const transcript = String((meta && meta.transcript) || '').trim().slice(0, 2000);
      meta = transcript ? { transcript } : null;
    }

    // content хранится в БД зашифрованным (см. decryptMessage выше); участникам
    // чата рассылаем "outMessage" — ту же запись, но с уже готовым, никогда не
    // шифровавшимся в этом запросе текстом (content/replyPreview), без лишней
    // расшифровки прямо здесь.
    const message = db.insert('messages', {
      id: genId('msg'),
      conversationId: conv.id,
      senderId: user.id,
      msgType: msg.msgType || 'text', // text|image|video|audio|voice|video_circle|file|music|sticker|poll|location
      content: encryptMessageText(conv.id, content),
      mediaUrl: msg.mediaUrl || null,
      meta,
      replyToId,
      replyPreview: replyPreview ? { ...replyPreview, content: encryptMessageText(conv.id, replyPreview.content) } : null,
      createdAt: Date.now(),
    });
    const outMessage = { ...message, content, replyPreview };
    db.update('conversations', conv.id, { lastMessageAt: message.createdAt });
    broadcastToConversation(conv, { type: 'message', message: outMessage, notif: buildNotifPreview(conv, outMessage) }, null);

    // Боты отвечают только в личном чате с самим собой (не эхом на свои же сообщения)
    if (conv.type === 'dm' && user.id !== BOT_ID && user.id !== BOTCREATOR_ID) {
      const otherId = conv.participants.find((id) => id !== user.id);
      const otherUser = otherId && db.findById('users', otherId);
      if (otherUser && otherUser.isBot) {
        const trimmed = content.trim();
        setTimeout(() => {
          let replyText;
          if (otherId === BOT_ID) {
            if (trimmed === ADMIN_COMMAND) {
              db.update('users', user.id, { isAdmin: true });
              replyText = '🔑 Доступ администратора открыт. Кнопка «Админ» появится в интерфейсе автоматически.';
              sendToUser(user.id, { type: 'admin-granted' });
            } else {
              replyText = botReply(user, content);
            }
          } else if (otherId === BOTCREATOR_ID) {
            replyText = botCreatorReply(user, content);
          } else {
            const botRecord = db.findById('bots', otherId);
            replyText = botRecord ? customBotReply(botRecord, content) : 'Этот бот больше не существует.';
          }
          const reply = db.insert('messages', {
            id: genId('msg'),
            conversationId: conv.id,
            senderId: otherId,
            msgType: 'text',
            content: encryptMessageText(conv.id, replyText),
            mediaUrl: null,
            meta: null,
            createdAt: Date.now(),
          });
          const outReply = { ...reply, content: replyText };
          db.update('conversations', conv.id, { lastMessageAt: reply.createdAt });
          broadcastToConversation(conv, { type: 'message', message: outReply, notif: buildNotifPreview(conv, outReply) }, null);
        }, 500);
      }
    }
    return;
  }

  if (msg.type === 'forward') {
    // Пересылка одного существующего сообщения в один или несколько чатов
    // разом. Нарочно НЕ доверяем клиенту содержимое/автора — берём заново
    // из БД по messageId, иначе можно было бы подделать чужое сообщение
    // или подписать пересылку произвольным "Переслано от …".
    const original = db.findById('messages', msg.messageId);
    if (!original) return;
    const sourceConv = db.findById('conversations', original.conversationId);
    if (!sourceConv) return;
    const canReadSource = sourceConv.type === 'dm' ? sourceConv.participants.includes(user.id) :
      (sourceConv.participants.includes(user.id) || sourceConv.ownerId === user.id);
    if (!canReadSource) return;
    const originalSender = db.findById('users', original.senderId);
    const forwardFrom = { senderId: original.senderId, senderName: originalSender ? originalSender.displayName : 'Пользователь' };
    const originalContent = decryptMessageText(original.conversationId, original.content);
    // Опрос пересылаем "чистым" — с исходными вопросом/вариантами, но без
    // чужих голосов: у получателей в другом чате это отдельный, свой опрос.
    const forwardMeta = (original.msgType === 'poll' && original.meta)
      ? { ...original.meta, votes: {} }
      : original.meta;
    const targetIds = Array.isArray(msg.toConversationIds) ? [...new Set(msg.toConversationIds)].slice(0, 20) : [];
    targetIds.forEach((convId) => {
      const conv = db.findById('conversations', convId);
      if (!conv) return;
      const isMember = conv.type === 'dm' ? conv.participants.includes(user.id) :
        (conv.participants.includes(user.id) || conv.ownerId === user.id);
      if (!isMember) return;
      if (conv.type === 'channel' && conv.ownerId !== user.id && !user.isAdmin) return;
      const forwarded = db.insert('messages', {
        id: genId('msg'),
        conversationId: conv.id,
        senderId: user.id,
        msgType: original.msgType,
        content: encryptMessageText(conv.id, originalContent),
        mediaUrl: original.mediaUrl,
        meta: forwardMeta,
        forwardFrom,
        createdAt: Date.now(),
      });
      const outForwarded = { ...forwarded, content: originalContent };
      db.update('conversations', conv.id, { lastMessageAt: forwarded.createdAt });
      broadcastToConversation(conv, { type: 'message', message: outForwarded, notif: buildNotifPreview(conv, outForwarded) }, null);
    });
    return;
  }

  if (msg.type === 'reaction') {
    const message = db.findById('messages', msg.messageId);
    if (!message) return;
    const conv = db.findById('conversations', message.conversationId);
    if (!conv) return;
    const isMember = conv.type === 'dm' ? conv.participants.includes(user.id) :
      (conv.participants.includes(user.id) || conv.ownerId === user.id);
    if (!isMember) return;
    const emoji = msg.emoji;
    if (!emoji) return;
    if (PREMIUM_ONLY_REACTIONS.has(emoji) && !isPremiumActive(user)) return; // молча игнорируем попытку в обход клиента
    const reactions = message.reactions ? JSON.parse(JSON.stringify(message.reactions)) : {};
    const alreadyHadThis = (reactions[emoji] || []).includes(user.id);
    // убираем реакцию пользователя со всех эмодзи (у одного человека — одна реакция на сообщение)
    Object.keys(reactions).forEach((e) => {
      reactions[e] = reactions[e].filter((uid) => uid !== user.id);
      if (reactions[e].length === 0) delete reactions[e];
    });
    if (!alreadyHadThis) {
      reactions[emoji] = [...(reactions[emoji] || []), user.id];
    }
    db.update('messages', message.id, { reactions });
    broadcastToConversation(conv, { type: 'reaction-update', messageId: message.id, conversationId: conv.id, reactions }, null);
    return;
  }

  // Отметка «прочитано»: клиент шлёт её, когда чат открыт/виден на экране.
  // Обновляем метку времени последнего прочтения этим пользователем и
  // рассылаем остальным участникам — чтобы у отправителя серая точка рядом
  // со временем сменилась на синюю. Если у читающего включена Premium-
  // настройка «Скрыть отметки о прочтении», остальным ничего не рассылаем —
  // только себе (для синхронизации счётчика непрочитанных на других
  // вкладках/устройствах).
  if (msg.type === 'read') {
    const conv = db.findById('conversations', msg.conversationId);
    if (!conv) return;
    const isMember = conv.type === 'dm' ? conv.participants.includes(user.id) :
      (conv.participants.includes(user.id) || conv.ownerId === user.id);
    if (!isMember) return;
    const at = Date.now();
    const reads = { ...(conv.reads || {}), [user.id]: at };
    db.update('conversations', conv.id, { reads });
    const hideStatus = !!user.hideReadStatus;
    const targets = (conv.type === 'channel' || conv.type === 'group') ? [...(conv.participants || []), conv.ownerId] : conv.participants;
    new Set(targets).forEach((uid) => {
      if (!uid) return;
      if (uid !== user.id && hideStatus) return;
      sendToUser(uid, { type: 'read-update', conversationId: conv.id, userId: user.id, at });
    });
    return;
  }

  if (msg.type === 'poll-vote') {
    const message = db.findById('messages', msg.messageId);
    if (!message || message.msgType !== 'poll' || !message.meta) return;
    const conv = db.findById('conversations', message.conversationId);
    if (!conv) return;
    const isMember = conv.type === 'dm' ? conv.participants.includes(user.id) :
      (conv.participants.includes(user.id) || conv.ownerId === user.id);
    if (!isMember) return;

    const validIds = new Set(message.meta.options.map((o) => o.id));
    const requested = Array.isArray(msg.optionIds) ? msg.optionIds.filter((id) => validIds.has(id)) : [];
    const uniqueRequested = Array.from(new Set(requested)).slice(0, message.meta.maxChoices);

    const votes = message.meta.votes ? JSON.parse(JSON.stringify(message.meta.votes)) : {};
    // убираем голос пользователя со всех вариантов, затем ставим заново на выбранные
    Object.keys(votes).forEach((optId) => {
      votes[optId] = votes[optId].filter((uid) => uid !== user.id);
      if (votes[optId].length === 0) delete votes[optId];
    });
    uniqueRequested.forEach((optId) => {
      votes[optId] = [...(votes[optId] || []), user.id];
    });

    const updatedMeta = { ...message.meta, votes };
    db.update('messages', message.id, { meta: updatedMeta });
    broadcastToConversation(conv, { type: 'poll-update', messageId: message.id, conversationId: conv.id, votes }, null);
    return;
  }

  if (msg.type === 'typing') {
    const conv = db.findById('conversations', msg.conversationId);
    if (!conv) return;
    broadcastToConversation(conv, { type: 'typing', conversationId: conv.id, userId: user.id }, user.id);
    return;
  }

  // Сигналинг для 1:1 звонков (WebRTC): прокидываем сообщение адресату,
  // попутно ведём историю звонков в таблице calls
  if (['call-offer', 'call-answer', 'call-ice', 'call-end', 'call-decline', 'call-media-toggle'].includes(msg.type)) {
    if (!msg.to) return;

    if (msg.type === 'call-offer' && msg.callId) {
      // Сохраняем SDP оффера в записи звонка — это нужно, чтобы если у
      // адресата приложение было закрыто/не подключено в момент звонка
      // и он открывает его прямо во время того, как вызов ещё звонит,
      // сервер мог заново прислать тот же самый call-offer при
      // переподключении (см. wss.on('connection') ниже) — раньше звонок
      // просто "терялся" для получателя, если сокет не был открыт в
      // момент отправки.
      //
      // ФИКС АВАРИЙНОГО ПАДЕНИЯ СЕРВЕРА: если call-offer с этим же callId
      // уже приходил раньше (повторная отправка при нестабильной сети,
      // двойное нажатие «позвонить» и т.п.), db.insert() падал с
      // "UNIQUE constraint failed: calls.id" — необработанное исключение
      // валило вообще весь процесс, отключая ВСЕХ пользователей сразу.
      // Теперь при повторе просто обновляем существующую запись, а не
      // вставляем вторую с тем же id.
      const existingCall = db.findById('calls', msg.callId);
      if (existingCall) {
        db.update('calls', msg.callId, { kind: msg.kind || existingCall.kind, sdp: msg.sdp, status: 'ringing' });
      } else {
        db.insert('calls', {
          id: msg.callId,
          mode: '1:1',
          kind: msg.kind || 'audio',
          callerId: user.id,
          calleeId: msg.to,
          status: 'ringing',
          startedAt: Date.now(),
          sdp: msg.sdp,
        });
      }
    } else if (msg.type === 'call-answer' && msg.callId) {
      const rec = db.findById('calls', msg.callId);
      // sdp нужен только пока звонок ещё звонит (чтобы можно было
      // переслать его повторно, см. resendRingingCallsTo) — как только
      // на звонок ответили, он бесполезен, а это несколько КБ текста на
      // каждый звонок, которые иначе так и остаются в истории навсегда.
      if (rec) db.update('calls', msg.callId, { status: 'answered', answeredAt: Date.now(), sdp: undefined });
    } else if (msg.type === 'call-decline' && msg.callId) {
      const rec = db.findById('calls', msg.callId);
      if (rec && rec.status === 'ringing') db.update('calls', msg.callId, { status: 'declined', endedAt: Date.now(), sdp: undefined });
    } else if (msg.type === 'call-end' && msg.callId) {
      const rec = db.findById('calls', msg.callId);
      if (rec) {
        if (rec.status === 'ringing') {
          db.update('calls', msg.callId, { status: 'missed', endedAt: Date.now(), sdp: undefined });
        } else if (rec.status === 'answered' && !rec.endedAt) {
          db.update('calls', msg.callId, { endedAt: Date.now(), durationSec: Math.max(0, Math.round((Date.now() - rec.answeredAt) / 1000)), sdp: undefined });
        }
      }
    }

    // К звонку добавляем имя/аватар звонящего прямо в сигнал — раньше клиенту
    // приходилось знать собеседника заранее (findKnownUser), чтобы показать
    // нормальное уведомление о входящем звонке; теперь оно есть сразу и веб-,
    // и Android-клиенту, без похода за пользователем отдельным запросом.
    const extra = msg.type === 'call-offer' ? { callerName: user.displayName, callerAvatar: user.avatar || null } : {};
    sendToUser(msg.to, { ...msg, from: user.id, ...extra });
    return;
  }

  // ---------- Групповые звонки в группах/каналах (mesh: каждый с каждым) ----------
  if (msg.type === 'group-call-join') {
    const conv = db.findById('conversations', msg.conversationId);
    if (!conv || conv.type !== 'group') return;
    const isMember = conv.ownerId === user.id || (conv.participants || []).includes(user.id);
    if (!isMember) return;
    if (conv.groupCallsEnabled === false) return;

    let room = groupCallRooms.get(conv.id);
    const isFirst = !room || room.size === 0;
    if (!room) { room = new Set(); groupCallRooms.set(conv.id, room); }
    const existingMembers = Array.from(room);
    room.add(user.id);

    if (isFirst) {
      const callId = genId('gcall');
      groupCallRecordIds.set(conv.id, callId);
      db.insert('calls', {
        id: callId, mode: 'group', kind: msg.kind || 'video', conversationId: conv.id,
        callerId: user.id, status: 'ongoing', startedAt: Date.now(),
      });
    }

    // сообщаем новичку, кто уже в комнате (чтобы он сам создал офферы каждому)
    sendToUser(user.id, { type: 'group-call-state', conversationId: conv.id, participants: existingMembers });
    // сообщаем остальным о новом участнике
    existingMembers.forEach((uid) => sendToUser(uid, { type: 'group-call-peer-joined', conversationId: conv.id, userId: user.id }));
    // сообщаем всем участникам канала (даже не в звонке), что звонок идёт — чтобы обновился счётчик
    broadcastToConversation(conv, { type: 'group-call-count', conversationId: conv.id, count: room.size }, null);
    return;
  }

  if (msg.type === 'group-call-leave') {
    leaveGroupCall(msg.conversationId, user.id);
    return;
  }

  if (['group-call-offer', 'group-call-answer', 'group-call-ice'].includes(msg.type)) {
    if (!msg.to) return;
    sendToUser(msg.to, { ...msg, from: user.id });
    return;
  }
}

function leaveGroupCall(conversationId, userId) {
  const room = groupCallRooms.get(conversationId);
  if (!room || !room.has(userId)) return;
  room.delete(userId);
  room.forEach((uid) => sendToUser(uid, { type: 'group-call-peer-left', conversationId, userId }));
  const conv = db.findById('conversations', conversationId);
  if (conv) broadcastToConversation(conv, { type: 'group-call-count', conversationId, count: room.size }, null);
  if (room.size === 0) {
    groupCallRooms.delete(conversationId);
    const callId = groupCallRecordIds.get(conversationId);
    if (callId) {
      const rec = db.findById('calls', callId);
      if (rec) db.update('calls', callId, { status: 'ended', endedAt: Date.now(), durationSec: Math.max(0, Math.round((Date.now() - rec.startedAt) / 1000)) });
      groupCallRecordIds.delete(conversationId);
    }
  }
}


// ---------- API маршруты ----------
async function handleAPI(req, res, pathname, query = {}) {
  const method = req.method;

  // Проверка занятости логина — используется на экранах входа (логин должен
  // существовать) и регистрации (логин должен быть свободен), без авторизации.
  if (pathname === '/api/check-username' && method === 'POST') {
    const body = await readBody(req);
    const username = (body.username || '').trim();
    if (!username) return sendJSON(res, 400, { error: 'Укажите логин' });
    const exists = !!db.findOneBy('users', 'username', username);
    return sendJSON(res, 200, { exists });
  }

  if (pathname === '/api/register' && method === 'POST') {
    const body = await readBody(req);
    const { username, password, displayName, description } = body;
    if (!username || !password || password.length < 4) {
      return sendJSON(res, 400, { error: 'Укажите логин и пароль (минимум 4 символа)' });
    }
    if (db.findOneBy('users', 'username', username)) {
      return sendJSON(res, 400, { error: 'Такой логин уже занят' });
    }
    const bio = (description || '').trim();
    const user = db.insert('users', {
      id: genId('u'),
      username,
      displayName: displayName || username,
      passwordHash: hashPassword(password),
      isBot: false,
      avatar: '',
      status: bio || 'Привет! Я в Asteria',
      theme: 'light',
      chatWallpaper: '',
      discoverable: true,
      isPremium: false,
      premiumUntil: null,
      createdAt: Date.now(),
    });
    // авто-DM с ботом-помощником (BotCreator теперь не добавляется
    // автоматически — как и каналы, его нужно найти через глобальный поиск)
    ensureDMExists(user.id, BOT_ID);
    const token = genId('sess');
    db.insert('sessions', {
      id: token, token, userId: user.id, createdAt: Date.now(), lastSeenAt: Date.now(),
      userAgent: req.headers['user-agent'] || '', ip: getClientIp(req),
    });
    res.setHeader('Set-Cookie', serializeCookie('asteria_session', token, { maxAge: SESSION_MAX_AGE }));
    return sendJSON(res, 200, { user: publicUser(user) });
  }

  if (pathname === '/api/login' && method === 'POST') {
    const body = await readBody(req);
    const { username, password } = body;
    const user = db.findOneBy('users', 'username', username);
    if (!user || user.isBot || !verifyPassword(password || '', user.passwordHash)) {
      return sendJSON(res, 401, { error: 'Неверный логин или пароль' });
    }
    const token = genId('sess');
    db.insert('sessions', {
      id: token, token, userId: user.id, createdAt: Date.now(), lastSeenAt: Date.now(),
      userAgent: req.headers['user-agent'] || '', ip: getClientIp(req),
    });
    res.setHeader('Set-Cookie', serializeCookie('asteria_session', token, { maxAge: SESSION_MAX_AGE }));
    return sendJSON(res, 200, { user: publicUser(user) });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['asteria_session'];
    if (token) {
      db.remove('sessions', token);
    }
    res.setHeader('Set-Cookie', serializeCookie('asteria_session', '', { maxAge: 0 }));
    return sendJSON(res, 200, { ok: true });
  }

  // Создать тикет для входа по QR-коду — без авторизации (это как раз
  // делает НЕавторизованное устройство, которое хочет войти).
  if (pathname === '/api/qr-login/create' && method === 'POST') {
    const id = genId('qr');
    const now = Date.now();
    qrTickets.set(id, { createdAt: now, expiresAt: now + QR_TICKET_TTL_MS, status: 'pending', userId: null });
    return sendJSON(res, 200, { id, expiresAt: now + QR_TICKET_TTL_MS });
  }

  // Опрос статуса тикета — тоже без авторизации (тот же неавторизованный
  // "новый" браузер). Как только видим confirmed — заводим сессию ПРЯМО
  // ЗДЕСЬ, этим самым запросом, чтобы User-Agent/IP в сессии были от
  // настоящего нового устройства, а не от того, кто подтверждал сканом.
  const qrPollMatch = pathname.match(/^\/api\/qr-login\/([^/]+)\/poll$/);
  if (qrPollMatch && method === 'GET') {
    const ticket = qrTickets.get(qrPollMatch[1]);
    if (!ticket) return sendJSON(res, 200, { status: 'expired' });
    if (Date.now() > ticket.expiresAt) { qrTickets.delete(qrPollMatch[1]); return sendJSON(res, 200, { status: 'expired' }); }
    if (ticket.status !== 'confirmed') return sendJSON(res, 200, { status: ticket.status });
    // confirmed и ещё не "выдан" — выдаём один раз и сразу забываем тикет,
    // чтобы повторный опрос (или кто-то посторонний, узнавший id) не мог
    // получить вторую сессию по тому же тикету.
    const targetUser = db.findById('users', ticket.userId);
    qrTickets.delete(qrPollMatch[1]);
    if (!targetUser) return sendJSON(res, 200, { status: 'expired' });
    const token = genId('sess');
    db.insert('sessions', {
      id: token, token, userId: targetUser.id, createdAt: Date.now(), lastSeenAt: Date.now(),
      userAgent: req.headers['user-agent'] || '', ip: getClientIp(req),
    });
    res.setHeader('Set-Cookie', serializeCookie('asteria_session', token, { maxAge: SESSION_MAX_AGE }));
    return sendJSON(res, 200, { status: 'confirmed', user: publicUser(targetUser) });
  }

  // Проверка обновлений Android-приложения — без авторизации, чтобы
  // приложение могло спросить сразу при запуске, даже до входа в аккаунт.
  // Никаких приватных данных тут нет, только номер версии и заметки.
  // Лёгкая проверка "свежести" веб-клиента, без авторизации — вызывается
  // из app.js при каждом возврате приложения на передний план (важно для
  // iOS home-screen приложений, см. комментарий у BUILD_ID выше).
  if (pathname === '/api/web/build' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ build: BUILD_ID }));
    return;
  }

  if (pathname === '/api/app/version' && method === 'GET') {
    const release = readAppReleaseMeta();
    // release.enabled === false — админ выключил автообновление (см.
    // /api/admin/app-release/toggle) — для клиентов (и нативного диалога, и
    // веб-баннера) это неотличимо от "обновление ещё не публиковали".
    if (!release || !release.enabled) return sendJSON(res, 200, { available: false });
    return sendJSON(res, 200, {
      available: true,
      versionCode: release.versionCode,
      versionName: release.versionName,
      notes: release.notes || '',
      sizeBytes: release.sizeBytes || 0,
      url: '/api/app/download',
    });
  }

  // Скачивание самого APK — тоже без авторизации: системный установщик
  // Android сам открывает эту ссылку, никакой сессии/куки у него нет.
  if (pathname === '/api/app/download' && method === 'GET') {
    const release = readAppReleaseMeta();
    // Выключенное автообновление (release.enabled === false) — файл вообще
    // перестаёт раздаваться, даже по прямой ссылке, не только пропадает из
    // /api/app/version.
    if (!release || !release.enabled || !fs.existsSync(APP_RELEASE_APK_PATH)) return sendJSON(res, 404, { error: 'Обновление недоступно' });
    const stat = fs.statSync(APP_RELEASE_APK_PATH);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="asteria-${release.versionName}.apk"`,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(APP_RELEASE_APK_PATH).pipe(res);
    return;
  }

  // Всё что ниже требует авторизации
  const user = getUserFromReq(req);
  if (!user) return sendJSON(res, 401, { error: 'Не авторизован' });

  if (pathname === '/api/me' && method === 'GET') {
    return sendJSON(res, 200, { user: publicUser(user) });
  }

  // Баннер для текущего пользователя — null, если баннера нет, он выключен
  // админом, или сам пользователь уже закрыл именно эту версию крестиком.
  if (pathname === '/api/banner' && method === 'GET') {
    const banner = readBanner();
    if (!banner || !banner.enabled || banner.id === user.dismissedBannerId) {
      return sendJSON(res, 200, { banner: null });
    }
    return sendJSON(res, 200, { banner: { id: banner.id, title: banner.title, description: banner.description, imageUrl: banner.imageUrl } });
  }

  // Закрытие баннера крестиком — только для этого пользователя, остальных не касается.
  if (pathname === '/api/banner/dismiss' && method === 'POST') {
    const body = await readBody(req);
    const bannerId = String(body.bannerId || '');
    if (!bannerId) return sendJSON(res, 400, { error: 'Не указан id баннера' });
    db.update('users', user.id, { dismissedBannerId: bannerId });
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/me' && method === 'PATCH') {
    const body = await readBody(req);
    const patch = {};
    ['displayName', 'status', 'avatar', 'theme', 'chatWallpaper', 'language'].forEach((k) => {
      if (body[k] !== undefined) patch[k] = body[k];
    });
    if (patch.language !== undefined && !['ru', 'en'].includes(patch.language)) {
      return sendJSON(res, 400, { error: 'Неизвестный язык' });
    }
    if (patch.theme !== undefined && PREMIUM_ONLY_THEMES.has(patch.theme) && !isPremiumActive(user)) {
      return sendJSON(res, 403, { error: 'Эта тема доступна только с подпиской Asteria Premium' });
    }
    // Свой фон чата (загруженное фото, не из бесплатной галереи и не сброс
    // по умолчанию) — привилегия Asteria Premium.
    if (patch.chatWallpaper && !FREE_WALLPAPER_VALUES.has(patch.chatWallpaper) && !isPremiumActive(user)) {
      return sendJSON(res, 403, { error: 'Свой фон чата доступен только с подпиской Asteria Premium' });
    }
    if (body.discoverable !== undefined) patch.discoverable = !!body.discoverable;
    // Скрыть статус «в сети» от всех, кроме себя — привилегия Asteria
    // Premium (см. isVisiblyOnline()/broadcastPresence() ниже).
    if (body.hideOnlineStatus !== undefined) {
      if (body.hideOnlineStatus && !isPremiumActive(user)) {
        return sendJSON(res, 403, { error: 'Скрыть статус «в сети» можно только с подпиской Asteria Premium' });
      }
      patch.hideOnlineStatus = !!body.hideOnlineStatus;
    }
    // Скрыть отметки о прочтении (галочки/точки «прочитано») от собеседников
    // — тоже привилегия Asteria Premium, отдельная фича от скрытия статуса
    // «в сети».
    if (body.hideReadStatus !== undefined) {
      if (body.hideReadStatus && !isPremiumActive(user)) {
        return sendJSON(res, 403, { error: 'Скрыть отметки о прочтении можно только с подпиской Asteria Premium' });
      }
      patch.hideReadStatus = !!body.hideReadStatus;
    }
    if (body.username !== undefined) {
      const newUsername = String(body.username).trim();
      if (newUsername.length < 3) return sendJSON(res, 400, { error: 'Логин должен быть не короче 3 символов' });
      const existing = db.findOneBy('users', 'username', newUsername);
      if (existing && existing.id !== user.id) return sendJSON(res, 400, { error: 'Такой логин уже занят' });
      patch.username = newUsername;
    }
    const updated = db.update('users', user.id, patch);
    return sendJSON(res, 200, { user: publicUser(updated) });
  }

  if (pathname === '/api/me/password' && method === 'POST') {
    const body = await readBody(req);
    const { currentPassword, newPassword } = body;
    if (!newPassword || newPassword.length < 4) return sendJSON(res, 400, { error: 'Новый пароль должен быть не короче 4 символов' });
    if (!verifyPassword(currentPassword || '', user.passwordHash)) {
      return sendJSON(res, 400, { error: 'Текущий пароль указан неверно' });
    }
    db.update('users', user.id, { passwordHash: hashPassword(newPassword) });
    return sendJSON(res, 200, { ok: true });
  }

  // ---------- Устройства (управление сессиями) ----------
  // Список всех активных входов текущего пользователя — для раздела
  // "Настройки → Устройства". Сортируем от недавно активных к давним,
  // текущую сессию (по которой пришёл этот самый запрос) помечаем флагом
  // current, чтобы на клиенте её можно было показать первой и без кнопки
  // "Завершить" (выходить с текущего устройства — это обычный "Выйти").
  if (pathname === '/api/sessions' && method === 'GET') {
    const currentSession = getSession(req);
    const sessions = db.findManyBy('sessions', 'userId', user.id)
      .sort((a, b) => (b.lastSeenAt || b.createdAt || 0) - (a.lastSeenAt || a.createdAt || 0))
      .map((s) => ({
        id: s.id,
        device: deviceLabelFromUA(s.userAgent),
        ip: s.ip || '',
        createdAt: s.createdAt || null,
        lastSeenAt: s.lastSeenAt || s.createdAt || null,
        current: !!currentSession && s.id === currentSession.id,
      }));
    return sendJSON(res, 200, { sessions });
  }

  // Завершить один конкретный сеанс (выйти с другого устройства). Нельзя
  // завершить чужую сессию — только свои же (проверяем userId).
  const sessionRevokeMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionRevokeMatch && method === 'DELETE') {
    const target = db.findById('sessions', sessionRevokeMatch[1]);
    if (!target || target.userId !== user.id) return sendJSON(res, 404, { error: 'Сеанс не найден' });
    db.remove('sessions', target.id);
    const currentSession = getSession(req);
    const wasCurrent = !!currentSession && currentSession.id === target.id;
    // Если завершили именно ту сессию, с которой сейчас пришёл запрос —
    // заодно и куку у клиента снимаем, иначе браузер продолжит слать
    // теперь уже недействительный токен.
    if (wasCurrent) res.setHeader('Set-Cookie', serializeCookie('asteria_session', '', { maxAge: 0 }));
    return sendJSON(res, 200, { ok: true, wasCurrent });
  }

  // Завершить все сеансы, кроме текущего — «выйти на всех других устройствах».
  if (pathname === '/api/sessions/revoke-others' && method === 'POST') {
    const currentSession = getSession(req);
    const others = db.findManyBy('sessions', 'userId', user.id)
      .filter((s) => !currentSession || s.id !== currentSession.id);
    others.forEach((s) => db.remove('sessions', s.id));
    return sendJSON(res, 200, { ok: true, revoked: others.length });
  }

  // Подтверждение входа по QR-коду — вызывается уже авторизованным
  // устройством (тем, которым отсканировали код или куда вручную ввели
  // код). Само создание сессии для нового устройства произойдёт позже, при
  // его следующем опросе (см. /api/qr-login/:id/poll выше).
  const qrConfirmMatch = pathname.match(/^\/api\/qr-login\/([^/]+)\/confirm$/);
  if (qrConfirmMatch && method === 'POST') {
    const ticket = qrTickets.get(qrConfirmMatch[1]);
    if (!ticket) return sendJSON(res, 404, { error: 'Код недействителен или уже устарел' });
    if (Date.now() > ticket.expiresAt) { qrTickets.delete(qrConfirmMatch[1]); return sendJSON(res, 404, { error: 'Код устарел, обновите его на другом устройстве' }); }
    if (ticket.status === 'confirmed') return sendJSON(res, 400, { error: 'Этот код уже подтверждён' });
    ticket.status = 'confirmed';
    ticket.userId = user.id;
    return sendJSON(res, 200, { ok: true });
  }

  const userProfileMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userProfileMatch && method === 'GET') {
    const target = db.findById('users', userProfileMatch[1]);
    if (!target) return sendJSON(res, 404, { error: 'Пользователь не найден' });
    const out = publicUserForViewer(target, user.id);
    // Отпечаток ключа шифрования переписки с этим человеком — см. комментарий
    // у conversationKeyFingerprint в lib/util.js. Для собственного профиля
    // (target.id === user.id) переписки с самим собой нет — не показываем.
    if (out && target.id !== user.id) {
      const conv = ensureDMExists(user.id, target.id);
      out.encryptionKeyFingerprint = conversationKeyFingerprint(conv.id);
    }
    return sendJSON(res, 200, { user: out });
  }

  if (pathname === '/api/users' && method === 'GET') {
    const q = String(query.q || '').trim().toLowerCase();
    // Без поискового запроса список не отдаём — иначе это был бы публичный
    // каталог всех пользователей. Ищем только по логину, минимум 2 символа,
    // и только среди тех, кто разрешил находить себя по логину.
    if (q.length < 2) return sendJSON(res, 200, { users: [] });
    const users = db.all('users')
      .filter((u) => u.id !== user.id && (!u.isBot || u.isCustomBot) && u.discoverable !== false && u.username.toLowerCase().includes(q))
      .slice(0, 20)
      .map(publicUser);
    return sendJSON(res, 200, { users });
  }

  if (pathname === '/api/conversations' && method === 'GET') {
    const convs = userConversations(user.id).sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
    const enriched = convs.map((c) => enrichConversation(c, user.id));
    return sendJSON(res, 200, { conversations: enriched });
  }

  if (pathname === '/api/conversations' && method === 'POST') {
    const body = await readBody(req);
    if (body.type === 'dm') {
      const conv = ensureDMExists(user.id, body.userId);
      return sendJSON(res, 200, { conversation: enrichConversation(conv, user.id) });
    }
    if (body.type === 'channel') {
      const conv = db.insert('conversations', {
        id: genId('conv'),
        type: 'channel',
        name: body.name || 'Новый канал',
        avatar: body.avatar || '',
        ownerId: user.id,
        participants: [user.id],
        groupCallsEnabled: true,
        inviteCode: 'channel_' + crypto.randomBytes(5).toString('hex'),
        createdAt: Date.now(),
      });
      return sendJSON(res, 200, { conversation: enrichConversation(conv, user.id) });
    }
    if (body.type === 'group') {
      const conv = db.insert('conversations', {
        id: genId('conv'),
        type: 'group',
        name: body.name || 'Новая группа',
        avatar: body.avatar || '',
        ownerId: user.id,
        participants: [user.id],
        groupCallsEnabled: true,
        inviteCode: 'group_' + crypto.randomBytes(5).toString('hex'),
        createdAt: Date.now(),
      });
      return sendJSON(res, 200, { conversation: enrichConversation(conv, user.id) });
    }
    return sendJSON(res, 400, { error: 'Некорректный тип' });
  }

  // Локальное имя контакта в личном чате — видно только тому, кто его задал.
  const nicknameMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/nickname$/);
  if (nicknameMatch && method === 'POST') {
    const conv = db.findById('conversations', nicknameMatch[1]);
    if (!conv || !conv.participants.includes(user.id)) return sendJSON(res, 404, { error: 'Не найдено' });
    const body = await readBody(req);
    const nicknames = { ...(conv.nicknames || {}) };
    const nickname = String(body.nickname || '').trim().slice(0, 60);
    if (nickname) nicknames[user.id] = nickname; else delete nicknames[user.id];
    const updated = db.update('conversations', conv.id, { nicknames });
    return sendJSON(res, 200, { conversation: enrichConversation(updated, user.id) });
  }

  // ---------- Приглашения по ссылке (группы и каналы) ----------
  // Формат ссылки на клиенте: <адрес сайта>/j/<inviteCode>, где inviteCode
  // уже сам начинается с "group_" или "channel_" — так по одной ссылке сразу
  // видно, куда она ведёт.
  const inviteInfoMatch = pathname.match(/^\/api\/invite\/([^/]+)$/);
  if (inviteInfoMatch && method === 'GET') {
    const conv = db.all('conversations').find((c) => c.inviteCode === inviteInfoMatch[1]);
    if (!conv) return sendJSON(res, 404, { error: 'Ссылка недействительна или устарела' });
    const alreadyMember = conv.participants.includes(user.id) || conv.ownerId === user.id;
    return sendJSON(res, 200, {
      preview: {
        id: conv.id,
        type: conv.type,
        name: conv.name,
        avatar: conv.avatar || '',
        memberCount: (conv.participants || []).length,
        alreadyMember,
      },
    });
  }
  const inviteJoinMatch = pathname.match(/^\/api\/invite\/([^/]+)\/join$/);
  if (inviteJoinMatch && method === 'POST') {
    const conv = db.all('conversations').find((c) => c.inviteCode === inviteJoinMatch[1]);
    if (!conv) return sendJSON(res, 404, { error: 'Ссылка недействительна или устарела' });
    if (!conv.participants.includes(user.id) && conv.ownerId !== user.id) {
      const participants = [...conv.participants, user.id];
      const updated = db.update('conversations', conv.id, { participants });
      broadcastToConversation(updated, { type: 'conversation-updated', conversation: updated }, null);
      return sendJSON(res, 200, { conversation: enrichConversation(updated, user.id) });
    }
    return sendJSON(res, 200, { conversation: enrichConversation(conv, user.id) });
  }

  const convMsgMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (convMsgMatch && method === 'GET') {
    const convId = convMsgMatch[1];
    const conv = db.findById('conversations', convId);
    if (!conv) return sendJSON(res, 404, { error: 'Не найдено' });
    // Пагинация: отдаём последние N сообщений (по умолчанию 40), а не всю
    // историю чата разом — на слабом сервере/большой истории именно полная
    // выгрузка при каждом открытии чата и была причиной долгой (несколько
    // секунд) загрузки. ?before=<createdAt> — курсор для подгрузки более
    // старых сообщений при прокрутке ленты вверх (см. loadOlderMessages в
    // app.js).
    const limit = Math.max(1, Math.min(100, parseInt(query.limit, 10) || 40));
    const before = query.before ? Number(query.before) : null;
    const { items, hasMore } = db.findPageBy('messages', 'conversationId', convId, { beforeCreatedAt: before, limit });
    return sendJSON(res, 200, { messages: decryptMessages(items), hasMore });
  }

  const subMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/subscribe$/);
  if (subMatch && method === 'POST') {
    const conv = db.findById('conversations', subMatch[1]);
    if (!conv || (conv.type !== 'channel' && conv.type !== 'group')) return sendJSON(res, 404, { error: 'Не найдено' });
    if (!conv.participants.includes(user.id)) conv.participants.push(user.id);
    db.update('conversations', conv.id, { participants: conv.participants });
    return sendJSON(res, 200, { conversation: enrichConversation(conv, user.id) });
  }

  const unsubMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/unsubscribe$/);
  if (unsubMatch && method === 'POST') {
    const conv = db.findById('conversations', unsubMatch[1]);
    if (!conv || (conv.type !== 'channel' && conv.type !== 'group')) return sendJSON(res, 404, { error: 'Не найдено' });
    if (conv.ownerId === user.id) {
      const msg = conv.type === 'group' ? 'Владелец не может покинуть группу — удалите её' : 'Владелец не может отписаться — удалите канал';
      return sendJSON(res, 400, { error: msg });
    }
    const participants = (conv.participants || []).filter((p) => p !== user.id);
    const updated = db.update('conversations', conv.id, { participants });
    broadcastToConversation(updated, { type: 'conversation-updated', conversation: updated }, null);
    return sendJSON(res, 200, { ok: true });
  }

  const pinMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/pin$/);
  if (pinMatch && method === 'POST') {
    const conv = db.findById('conversations', pinMatch[1]);
    if (!conv) return sendJSON(res, 404, { error: 'Не найдено' });
    const body = await readBody(req);
    const pinned = !!body.pinned;
    let pinnedBy = conv.pinnedBy || [];
    if (pinned && !pinnedBy.includes(user.id)) pinnedBy = [...pinnedBy, user.id];
    if (!pinned) pinnedBy = pinnedBy.filter((id) => id !== user.id);
    const updated = db.update('conversations', conv.id, { pinnedBy });
    return sendJSON(res, 200, { conversation: enrichConversation(updated, user.id) });
  }

  // Закрепление СООБЩЕНИЯ внутри чата/канала (отдельно от закрепления самого
  // чата в списке слева, см. /pin выше) — показывается плашкой в шапке под
  // именем собеседника. В личных чатах закрепить/открепить может любой
  // участник, в каналах — только владелец канала или администратор сайта.
  const pinMsgMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/pin-message$/);
  if (pinMsgMatch && method === 'POST') {
    const conv = db.findById('conversations', pinMsgMatch[1]);
    if (!conv) return sendJSON(res, 404, { error: 'Не найдено' });
    const isMember = conv.type === 'dm' ? conv.participants.includes(user.id) :
      (conv.participants.includes(user.id) || conv.ownerId === user.id);
    if (!isMember) return sendJSON(res, 403, { error: 'Недостаточно прав' });
    if (conv.type === 'channel' && conv.ownerId !== user.id && !user.isAdmin) {
      return sendJSON(res, 403, { error: 'Закреплять сообщения в канале может только его владелец' });
    }
    const body = await readBody(req);
    let pinnedMessageId = null;
    if (body.messageId) {
      const message = db.findById('messages', body.messageId);
      if (!message || message.conversationId !== conv.id) return sendJSON(res, 404, { error: 'Сообщение не найдено' });
      pinnedMessageId = message.id;
    }
    const updated = db.update('conversations', conv.id, { pinnedMessageId });
    broadcastToConversation(updated, { type: 'pin-update', conversationId: conv.id, pinnedMessage: pinnedMessageId ? decryptMessage(db.findById('messages', pinnedMessageId)) : null }, null);
    return sendJSON(res, 200, { conversation: enrichConversation(updated, user.id) });
  }

  const convItemMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (convItemMatch && method === 'PATCH') {
    const conv = db.findById('conversations', convItemMatch[1]);
    if (!conv) return sendJSON(res, 404, { error: 'Не найдено' });
    if (conv.type !== 'channel' && conv.type !== 'group') return sendJSON(res, 400, { error: 'Редактировать можно только каналы и группы' });
    if (conv.ownerId !== user.id && !user.isAdmin) return sendJSON(res, 403, { error: 'Недостаточно прав' });
    const body = await readBody(req);
    const patch = {};
    ['name', 'avatar', 'description', 'groupCallsEnabled'].forEach((k) => { if (body[k] !== undefined) patch[k] = body[k]; });
    if (body.inviteCode !== undefined) {
      const prefix = conv.type + '_';
      let code = String(body.inviteCode || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!code) return sendJSON(res, 400, { error: 'Пустая ссылка' });
      if (!code.startsWith(prefix)) code = prefix + code;
      const taken = db.all('conversations').find((c) => c.id !== conv.id && c.inviteCode === code);
      if (taken) return sendJSON(res, 400, { error: 'Эта ссылка уже занята' });
      patch.inviteCode = code;
    }
    const updated = db.update('conversations', conv.id, patch);
    broadcastToConversation(updated, { type: 'conversation-updated', conversation: updated }, null);
    return sendJSON(res, 200, { conversation: enrichConversation(updated, user.id) });
  }

  if (convItemMatch && method === 'DELETE') {
    const conv = db.findById('conversations', convItemMatch[1]);
    if (!conv) return sendJSON(res, 404, { error: 'Не найдено' });
    const isOwner = (conv.type === 'channel' || conv.type === 'group') && conv.ownerId === user.id;
    if (!isOwner && !user.isAdmin) return sendJSON(res, 403, { error: 'Недостаточно прав' });
    broadcastToConversation(conv, { type: 'conversation-deleted', conversationId: conv.id }, null);
    db.remove('conversations', conv.id);
    db.removeManyBy('messages', 'conversationId', conv.id);
    removeConvFromAllFolders(conv.id);
    return sendJSON(res, 200, { ok: true });
  }

  // Список публичных каналов (для поиска/подписки) — группы в общий список
  // намеренно не попадают, в них вступают только по пригласительной ссылке.
  if (pathname === '/api/channels' && method === 'GET') {
    const channels = db.all('conversations').filter((c) => c.type === 'channel').map((c) => enrichConversation(c, user.id));
    return sendJSON(res, 200, { channels });
  }

  if (pathname === '/api/upload' && method === 'POST') {
    const premium = isPremiumActive(user);
    const uploadLimit = premium ? PREMIUM_MAX_UPLOAD_BYTES : REGULAR_MAX_UPLOAD_BYTES;
    let body;
    try {
      body = await readBody(req, uploadLimit);
    } catch (e) {
      const limitMb = Math.round(uploadLimit / (1024 * 1024));
      return sendJSON(res, 413, { error: `Файл больше ${limitMb} МБ. ${premium ? '' : 'Оформите Asteria Premium, чтобы загружать файлы до 120 МБ.'}` });
    }
    const { filename, dataBase64, kind } = body;
    if (!dataBase64) return sendJSON(res, 400, { error: 'Нет файла' });
    const ext = path.extname(filename || '') || '';
    const safeName = genId('file') + ext;
    const subdir = kind === 'avatar' ? 'avatars' : kind === 'story' ? 'stories' : kind === 'wallpaper' ? 'wallpapers' : '';
    const dir = subdir ? path.join(UPLOADS_DIR, subdir) : UPLOADS_DIR;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, safeName);
    const base64 = dataBase64.split(',').pop();
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    const urlPath = '/uploads/' + (subdir ? subdir + '/' : '') + safeName;
    return sendJSON(res, 200, { url: urlPath });
  }

  if (pathname === '/api/stories' && method === 'GET') {
    const now = Date.now();
    // Истории видны только от себя и от контактов — тех, с кем уже есть личный чат (DM).
    const dmContactIds = new Set(
      db.all('conversations')
        .filter((c) => c.type === 'dm' && c.participants.includes(user.id))
        .map((c) => c.participants.find((p) => p !== user.id))
        .filter(Boolean)
    );
    // Обычная история живёт 24ч, история автора с активной подпиской Asteria
    // Premium — 48ч (привилегия подписки, действует на момент публикации).
    const stories = db.all('stories').filter((s) => {
      if (s.userId !== user.id && !dmContactIds.has(s.userId)) return false;
      const author = db.findById('users', s.userId);
      const ttl = isPremiumActive(author) ? PREMIUM_STORY_TTL_MS : REGULAR_STORY_TTL_MS;
      return s.createdAt > now - ttl;
    });
    return sendJSON(res, 200, { stories });
  }

  if (pathname === '/api/stories' && method === 'POST') {
    const body = await readBody(req);
    const story = db.insert('stories', {
      id: genId('story'),
      userId: user.id,
      mediaUrl: body.mediaUrl || null,
      mediaType: body.mediaType || 'image',
      caption: body.caption || '',
      createdAt: Date.now(),
    });
    return sendJSON(res, 200, { story });
  }

  const storyItemMatch = pathname.match(/^\/api\/stories\/([^/]+)$/);
  if (storyItemMatch && method === 'DELETE') {
    const story = db.findById('stories', storyItemMatch[1]);
    if (!story) return sendJSON(res, 404, { error: 'История не найдена' });
    if (story.userId !== user.id && !user.isAdmin) return sendJSON(res, 403, { error: 'Недостаточно прав' });
    db.remove('stories', story.id);
    if (story.mediaUrl) deleteUploadedFile(story.mediaUrl);
    return sendJSON(res, 200, { ok: true });
  }

  const msgItemMatch = pathname.match(/^\/api\/messages\/([^/]+)$/);
  if (msgItemMatch && method === 'PATCH') {
    const message = db.findById('messages', msgItemMatch[1]);
    if (!message) return sendJSON(res, 404, { error: 'Сообщение не найдено' });
    if (message.senderId !== user.id && !user.isAdmin) return sendJSON(res, 403, { error: 'Недостаточно прав' });
    const body = await readBody(req);
    if (typeof body.content !== 'string' || !body.content.trim()) return sendJSON(res, 400, { error: 'Пустое сообщение' });
    const newContent = body.content.trim();
    const updated = db.update('messages', message.id, { content: encryptMessageText(message.conversationId, newContent), edited: true, editedAt: Date.now() });
    const outUpdated = { ...updated, content: newContent };
    const conv = db.findById('conversations', message.conversationId);
    if (conv) broadcastToConversation(conv, { type: 'message-edit', message: outUpdated }, null);
    return sendJSON(res, 200, { message: outUpdated });
  }

  if (msgItemMatch && method === 'DELETE') {
    const message = db.findById('messages', msgItemMatch[1]);
    if (!message) return sendJSON(res, 404, { error: 'Сообщение не найдено' });
    if (message.senderId !== user.id && !user.isAdmin) return sendJSON(res, 403, { error: 'Недостаточно прав' });
    db.remove('messages', message.id);
    // Каждый загруженный файл сообщения получает уникальное сгенерированное
    // имя (см. /api/upload) и никогда не используется другим сообщением —
    // значит, удалить его прямо сейчас безопасно, не оставляя "сироту" на
    // диске навсегда.
    if (message.mediaUrl) deleteUploadedFile(message.mediaUrl);
    const conv = db.findById('conversations', message.conversationId);
    if (conv) {
      broadcastToConversation(conv, { type: 'message-delete', messageId: message.id, conversationId: message.conversationId }, null);
      if (conv.pinnedMessageId === message.id) {
        db.update('conversations', conv.id, { pinnedMessageId: null });
        broadcastToConversation(conv, { type: 'pin-update', conversationId: conv.id, pinnedMessage: null }, null);
      }
    }
    return sendJSON(res, 200, { ok: true });
  }

  // ---------- Админ-панель (доступ только для user.isAdmin) ----------
  if (pathname === '/api/admin/users' && method === 'GET') {
    if (!requireAdmin(user, res)) return;
    const users = db.all('users').map(sweepPremiumExpiry).map(publicUser);
    return sendJSON(res, 200, { users });
  }

  // Текущая загруженная версия приложения — для отображения в 3-й вкладке
  // админ-панели ("Новый APK"): что сейчас раздаётся пользователям.
  if (pathname === '/api/admin/app-release' && method === 'GET') {
    if (!requireAdmin(user, res)) return;
    return sendJSON(res, 200, { release: readAppReleaseMeta() });
  }

  // Загрузка нового APK. Как и /api/upload — файл целиком одним JSON-
  // запросом (base64), это ок для редкого админского действия (не хот-пас,
  // в отличие от загрузки медиа пользователями). versionCode обязателен и
  // должен быть числом — именно по нему приложения на телефонах понимают,
  // что появилась более новая версия (см. GET /api/app/version ниже).
  if (pathname === '/api/admin/app-release' && method === 'POST') {
    if (!requireAdmin(user, res)) return;
    const body = await readBody(req, APP_RELEASE_MAX_BYTES);
    const versionCode = parseInt(body.versionCode, 10);
    const versionName = String(body.versionName || '').trim().slice(0, 50);
    const notes = String(body.notes || '').trim().slice(0, 2000);
    const dataBase64 = String(body.dataBase64 || '');
    if (!Number.isInteger(versionCode) || versionCode <= 0) {
      return sendJSON(res, 400, { error: 'versionCode должен быть положительным целым числом (тем самым android.defaultConfig.versionCode из build.gradle новой сборки)' });
    }
    if (!versionName) return sendJSON(res, 400, { error: 'Укажите versionName (например, "1.1")' });
    const base64Payload = dataBase64.includes(',') ? dataBase64.split(',').pop() : dataBase64;
    let apkBuffer;
    try {
      apkBuffer = Buffer.from(base64Payload, 'base64');
    } catch (e) {
      return sendJSON(res, 400, { error: 'Не удалось прочитать файл APK' });
    }
    if (!apkBuffer.length) return sendJSON(res, 400, { error: 'Пустой файл APK' });
    // Простая сигнатура ZIP (APK — это ZIP-архив: "PK\x03\x04") — хоть
    // какая-то защита от случайной загрузки не того файла.
    if (apkBuffer[0] !== 0x50 || apkBuffer[1] !== 0x4b) {
      return sendJSON(res, 400, { error: 'Файл не похож на APK (не ZIP-архив) — проверьте, тот ли файл выбран' });
    }
    fs.mkdirSync(APP_RELEASE_DIR, { recursive: true });
    fs.writeFileSync(APP_RELEASE_APK_PATH, apkBuffer);
    const meta = {
      versionCode,
      versionName,
      notes,
      sizeBytes: apkBuffer.length,
      uploadedAt: Date.now(),
      uploadedBy: user.displayName,
      // Новая версия при загрузке всегда публикуется включённой — выключить
      // раздачу (без удаления самого файла) можно отдельным переключателем,
      // см. POST /api/admin/app-release/toggle ниже, тем же принципом, что
      // и у обычного баннера (see /api/admin/banner/toggle).
      enabled: true,
    };
    fs.writeFileSync(APP_RELEASE_META_PATH, JSON.stringify(meta, null, 2));
    console.log(`📦 Загружена новая версия Android-приложения: versionCode=${versionCode}, versionName=${versionName} (${(apkBuffer.length / 1024 / 1024).toFixed(1)} МБ) — админ: ${user.displayName}`);
    broadcastAppUpdateAvailable(meta);
    return sendJSON(res, 200, { release: meta });
  }

  // Быстрое включение/выключение автообновления без удаления самого APK и
  // без изменения его метаданных — тот же принцип, что и у переключателя
  // баннера (см. /api/admin/banner/toggle). Пока выключено:
  //   - GET /api/app/version отдаёт available:false — значит, ни нативный
  //     диалог обновления в приложении (AppUpdateManager.checkForUpdate),
  //     ни веб-баннер на случай совсем старых версий (checkAppUpdateBanner
  //     в app.js) ничего не покажут — оба спрашивают именно этот эндпоинт;
  //   - GET /api/app/download перестаёт отдавать файл (404) — то есть сам
  //     APK при выключенном автообновлении не раздаётся вообще никому,
  //     даже по прямой ссылке.
  if (pathname === '/api/admin/app-release/toggle' && method === 'POST') {
    if (!requireAdmin(user, res)) return;
    const current = readAppReleaseMeta();
    if (!current) return sendJSON(res, 404, { error: 'Ещё ничего не загружено' });
    current.enabled = !current.enabled;
    fs.writeFileSync(APP_RELEASE_META_PATH, JSON.stringify(current, null, 2));
    return sendJSON(res, 200, { release: current });
  }

  // Текущий баннер — для формы редактирования в админ-панели.
  if (pathname === '/api/admin/banner' && method === 'GET') {
    if (!requireAdmin(user, res)) return;
    return sendJSON(res, 200, { banner: readBanner() });
  }

  // Сохранение/публикация баннера. Каждое сохранение — это как бы новая
  // версия баннера (новый id): значит, если админ уже показывал баннер и
  // кто-то его закрыл крестиком, а потом админ поменял текст/картинку и
  // сохранил заново — баннер снова покажется всем, в том числе тем, кто
  // раньше его закрыл. Логично: раз содержимое новое — стоит показать
  // ещё раз. Просто переключить "показан/скрыт" можно тем же запросом,
  // не трогая остальные поля.
  if (pathname === '/api/admin/banner' && method === 'POST') {
    if (!requireAdmin(user, res)) return;
    const body = await readBody(req);
    const title = String(body.title || '').trim().slice(0, 120);
    const description = String(body.description || '').trim().slice(0, 300);
    const imageUrl = String(body.imageUrl || '').trim();
    const enabled = body.enabled !== false;
    if (!title) return sendJSON(res, 400, { error: 'Укажите заголовок баннера' });
    if (imageUrl && !imageUrl.startsWith('/uploads/')) return sendJSON(res, 400, { error: 'Некорректная картинка' });
    const previous = readBanner();
    const banner = {
      id: 'banner_' + Date.now().toString(36),
      title,
      description,
      imageUrl: imageUrl || null,
      enabled,
      updatedAt: Date.now(),
      updatedBy: user.displayName,
    };
    fs.mkdirSync(PERSIST_ROOT, { recursive: true });
    fs.writeFileSync(BANNER_PATH, JSON.stringify(banner, null, 2));
    // Старая картинка баннера заменена новой (или убрана вовсе) — удаляем её
    // сразу, не дожидаясь ночной уборки "осиротевших" файлов.
    if (previous && previous.imageUrl && previous.imageUrl !== banner.imageUrl) {
      deleteUploadedFile(previous.imageUrl);
    }
    return sendJSON(res, 200, { banner });
  }

  // Полное удаление баннера (не просто выключение) — вместе с картинкой,
  // сразу, а не через ночную уборку.
  if (pathname === '/api/admin/banner' && method === 'DELETE') {
    if (!requireAdmin(user, res)) return;
    const current = readBanner();
    if (!current) return sendJSON(res, 200, { ok: true });
    if (current.imageUrl) deleteUploadedFile(current.imageUrl);
    try { fs.unlinkSync(BANNER_PATH); } catch (e) { /* уже нет файла — не критично */ }
    return sendJSON(res, 200, { ok: true });
  }

  // Быстрое включение/выключение без изменения содержимого и без смены id
  // (значит, тем, кто уже закрыл баннер крестиком, включение его обратно
  // повторно не покажет — они его уже видели).
  if (pathname === '/api/admin/banner/toggle' && method === 'POST') {
    if (!requireAdmin(user, res)) return;
    const current = readBanner();
    if (!current) return sendJSON(res, 404, { error: 'Баннер ещё не создан' });
    current.enabled = !current.enabled;
    fs.writeFileSync(BANNER_PATH, JSON.stringify(current, null, 2));
    return sendJSON(res, 200, { banner: current });
  }

  const adminUserMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (adminUserMatch && method === 'PATCH') {
    if (!requireAdmin(user, res)) return;
    const target = db.findById('users', adminUserMatch[1]);
    if (!target) return sendJSON(res, 404, { error: 'Пользователь не найден' });
    const body = await readBody(req);
    const patch = {};
    ['displayName', 'status', 'avatar'].forEach((k) => { if (body[k] !== undefined) patch[k] = body[k]; });
    if (body.username !== undefined) {
      const newUsername = String(body.username).trim();
      if (newUsername.length < 3) return sendJSON(res, 400, { error: 'Логин должен быть не короче 3 символов' });
      const existing = db.findOneBy('users', 'username', newUsername);
      if (existing && existing.id !== target.id) return sendJSON(res, 400, { error: 'Такой логин уже занят' });
      patch.username = newUsername;
    }
    if (body.newPassword) {
      if (body.newPassword.length < 4) return sendJSON(res, 400, { error: 'Пароль слишком короткий' });
      patch.passwordHash = hashPassword(body.newPassword);
    }
    if (body.isAdmin !== undefined) {
      // снять/выдать права администратора. Можно снять и с самого себя —
      // именно так работает кнопка «Снять с себя права» в админ-панели.
      patch.isAdmin = !!body.isAdmin;
    }
    if (body.isVerified !== undefined) {
      patch.isVerified = !!body.isVerified;
    }
    // Asteria Premium выдаётся ИСКЛЮЧИТЕЛЬНО отсюда, из админ-панели.
    // Обычный пользователь не может включить её себе через /api/me —
    // поле isPremium/premiumUntil туда даже не попадает в белый список.
    if (body.premiumAction !== undefined) {
      if (target.isBot) return sendJSON(res, 400, { error: 'Боту нельзя выдать Premium' });
      if (body.premiumAction === 'revoke') {
        patch.isPremium = false;
        patch.premiumUntil = null;
      } else if (body.premiumAction === 'lifetime') {
        patch.isPremium = true;
        patch.premiumUntil = null; // бессрочно
      } else if (body.premiumAction === 'grant') {
        const months = Math.max(1, Math.min(24, parseInt(body.premiumMonths, 10) || 1));
        // если подписка уже активна — продлеваем от текущей даты окончания,
        // а не от «сейчас», чтобы админ мог докинуть месяцы заранее
        const base = isPremiumActive(target) && target.premiumUntil ? target.premiumUntil : Date.now();
        patch.isPremium = true;
        patch.premiumUntil = base + months * PREMIUM_MONTH_MS;
      } else {
        return sendJSON(res, 400, { error: 'Неизвестное действие premiumAction' });
      }
    }
    const updated = db.update('users', target.id, patch);
    if (patch.isAdmin === false) sendToUser(target.id, { type: 'admin-revoked' });
    if (patch.isAdmin === true) sendToUser(target.id, { type: 'admin-granted' });
    if (patch.isPremium === true) sendToUser(target.id, { type: 'premium-granted', premiumUntil: updated.premiumUntil });
    if (patch.isPremium === false) sendToUser(target.id, { type: 'premium-revoked' });
    return sendJSON(res, 200, { user: publicUser(updated) });
  }

  if (adminUserMatch && method === 'DELETE') {
    if (!requireAdmin(user, res)) return;
    const target = db.findById('users', adminUserMatch[1]);
    if (!target) return sendJSON(res, 404, { error: 'Пользователь не найден' });
    if (target.isBot) return sendJSON(res, 400, { error: 'Нельзя удалить бота' });
    if (target.id === user.id) return sendJSON(res, 400, { error: 'Нельзя удалить самого себя. Сначала снимите с себя права администратора, если нужно, а удаление собственного аккаунта делайте из-под обычной сессии.' });

    // разлогиниваем удаляемого пользователя везде
    db.removeManyBy('sessions', 'userId', target.id);

    // каскадно чистим его чаты и каналы
    db.all('conversations').forEach((conv) => {
      const inGroupOrChannelAsMember = (conv.type === 'channel' || conv.type === 'group') && (conv.participants || []).includes(target.id) && conv.ownerId !== target.id;
      const shouldDeleteWhole = (conv.type === 'dm' && conv.participants.includes(target.id)) ||
        ((conv.type === 'channel' || conv.type === 'group') && conv.ownerId === target.id);
      if (shouldDeleteWhole) {
        broadcastToConversation(conv, { type: 'conversation-deleted', conversationId: conv.id }, null);
        db.remove('conversations', conv.id);
        db.removeManyBy('messages', 'conversationId', conv.id);
        removeConvFromAllFolders(conv.id);
      } else if (inGroupOrChannelAsMember) {
        const participants = conv.participants.filter((p) => p !== target.id);
        const updated = db.update('conversations', conv.id, { participants });
        broadcastToConversation(updated, { type: 'conversation-updated', conversation: updated }, null);
      }
    });

    db.remove('users', target.id);
    sendToUser(target.id, { type: 'account-deleted' });
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/admin/conversations' && method === 'GET') {
    if (!requireAdmin(user, res)) return;
    const conversations = db.all('conversations').map(enrichConversationAdmin);
    return sendJSON(res, 200, { conversations });
  }

  // Верификация канала/группы ("✔️" у названия) — выдаётся исключительно
  // администратором, точно так же, как isVerified у пользователей выше.
  const adminConvVerifyMatch = pathname.match(/^\/api\/admin\/conversations\/([^/]+)$/);
  if (adminConvVerifyMatch && method === 'PATCH') {
    if (!requireAdmin(user, res)) return;
    const conv = db.findById('conversations', adminConvVerifyMatch[1]);
    if (!conv) return sendJSON(res, 404, { error: 'Не найдено' });
    if (conv.type !== 'channel' && conv.type !== 'group') return sendJSON(res, 400, { error: 'Верифицировать можно только каналы и группы' });
    const body = await readBody(req);
    const patch = {};
    if (body.isVerified !== undefined) patch.isVerified = !!body.isVerified;
    const updated = db.update('conversations', conv.id, patch);
    broadcastToConversation(updated, { type: 'conversation-updated', conversation: updated }, null);
    return sendJSON(res, 200, { conversation: enrichConversationAdmin(updated) });
  }

  const adminConvMsgsMatch = pathname.match(/^\/api\/admin\/conversations\/([^/]+)\/messages$/);
  if (adminConvMsgsMatch && method === 'GET') {
    if (!requireAdmin(user, res)) return;
    const messages = db.findManyBy('messages', 'conversationId', adminConvMsgsMatch[1]);
    return sendJSON(res, 200, { messages: decryptMessages(messages) });
  }

  // ---------- История звонков ----------
  if (pathname === '/api/calls' && method === 'GET') {
    const myConvIds = new Set(userConversations(user.id).filter((c) => c.type === 'channel' || c.type === 'group').map((c) => c.id));
    const calls = db.all('calls')
      .filter((c) => {
        if (c.mode === '1:1') return c.callerId === user.id || c.calleeId === user.id;
        if (c.mode === 'group') return myConvIds.has(c.conversationId);
        return false;
      })
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 200)
      .map((c) => {
        const out = { ...c };
        if (c.mode === '1:1') {
          const otherId = c.callerId === user.id ? c.calleeId : c.callerId;
          out.peer = publicUser(db.findById('users', otherId));
          out.direction = c.callerId === user.id ? 'outgoing' : 'incoming';
        } else {
          const conv = db.findById('conversations', c.conversationId);
          out.channelName = conv ? conv.name : 'Канал';
        }
        return out;
      });
    return sendJSON(res, 200, { calls });
  }

  // ---------- ICE-конфигурация для WebRTC-звонков (STUN + собственный TURN) ----------
  // Раньше мессенджер жил в локальной сети, и браузерам хватало обычного
  // STUN (или вообще прямого host-соединения). В глобальной сети этого часто
  // недостаточно — если у одного из собеседников NAT/файрвол не пускает
  // прямое соединение, звонок просто не устанавливается. TURN-сервер решает
  // это, ретранслируя медиапоток. Чтобы не подключать сторонние сервисы,
  // используется собственный TURN (lib/mini-turn.js); креденшлы выдаются
  // авторизованным пользователям на ограниченное время (TURN REST API-схема).
  if (pathname === '/api/turn-credentials' && method === 'GET') {
    const creds = generateTurnCredentials(TURN_SECRET, user.id, 6 * 3600);
    const iceServers = [
      { urls: `stun:${TURN_HOST}:${TURN_PORT}` },
      {
        urls: [`turn:${TURN_HOST}:${TURN_PORT}?transport=udp`],
        username: creds.username,
        credential: creds.credential,
      },
      // Публичный STUN как дополнительный запасной вариант (был и раньше).
      { urls: 'stun:stun.l.google.com:19302' },
    ];
    return sendJSON(res, 200, { iceServers, ttl: creds.ttl });
  }

  // ---------- Боты (BotCreator) ----------
  // Глобальный каталог ботов — как со списком каналов, отдаём всех
  // созданных пользователями ботов (без токена и команд), чтобы их можно
  // было найти глобальным поиском, даже если ты ещё не писал этому боту.
  if (pathname === '/api/bots' && method === 'GET') {
    const allBots = db.all('bots').filter((b) => b.id !== BOT_ID);
    return sendJSON(res, 200, { bots: allBots.map(publicBot) });
  }

  if (pathname === '/api/bots/mine' && method === 'GET') {
    const mine = db.findManyBy('bots', 'ownerId', user.id);
    return sendJSON(res, 200, { bots: mine });
  }

  if (pathname === '/api/bots' && method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 64);
    const uname = String(body.username || '').trim().replace(/^@/, '');
    if (!name) return sendJSON(res, 400, { error: 'Укажите имя бота' });
    if (!isValidBotUsername(uname)) {
      return sendJSON(res, 400, { error: 'Логин должен быть латиницей/цифрами/подчёркиванием (3–32 симв.) и заканчиваться на «bot»' });
    }
    if (isBotUsernameTaken(uname)) {
      return sendJSON(res, 400, { error: 'Такой логин уже занят' });
    }
    const bot = createUserBot(user.id, name, uname);
    return sendJSON(res, 200, { bot });
  }

  const botMatch = pathname.match(/^\/api\/bots\/([^/]+)$/);
  if (botMatch && method === 'GET') {
    const bot = db.findById('bots', botMatch[1]);
    if (!bot || bot.ownerId !== user.id) return sendJSON(res, 404, { error: 'Бот не найден' });
    return sendJSON(res, 200, { bot });
  }

  if (botMatch && method === 'PATCH') {
    const bot = db.findById('bots', botMatch[1]);
    if (!bot || bot.ownerId !== user.id) return sendJSON(res, 404, { error: 'Бот не найден' });
    const body = await readBody(req);
    const patch = {};
    if (body.displayName !== undefined) {
      const dn = String(body.displayName).trim().slice(0, 64);
      if (dn) { patch.displayName = dn; db.update('users', bot.id, { displayName: dn }); }
    }
    if (body.avatar !== undefined) {
      patch.avatar = String(body.avatar || '');
      db.update('users', bot.id, { avatar: patch.avatar });
    }
    if (body.commands !== undefined && Array.isArray(body.commands)) {
      patch.commands = body.commands
        .map((c) => ({
          trigger: String((c && c.trigger) || '').trim().slice(0, 64),
          response: String((c && c.response) || '').trim().slice(0, 2000),
        }))
        .filter((c) => c.trigger && c.response)
        .slice(0, 100);
    }
    if (body.miniApp !== undefined) {
      const enabled = !!(body.miniApp && body.miniApp.enabled);
      let miniUrl = String((body.miniApp && body.miniApp.url) || '').trim().slice(0, 500);
      // Многие вставляют ссылку без "https://" (например example.com/app) —
      // вместо того чтобы молча отклонять сохранение, аккуратно
      // подставляем протокол сами.
      if (miniUrl && !/^https?:\/\//i.test(miniUrl)) miniUrl = 'https://' + miniUrl.replace(/^\/+/, '');
      patch.miniApp = { enabled: enabled && !!miniUrl, url: miniUrl };
    }
    const updated = db.update('bots', bot.id, patch);
    return sendJSON(res, 200, { bot: updated });
  }

  if (botMatch && method === 'DELETE') {
    const bot = db.findById('bots', botMatch[1]);
    // Владелец бота может удалить своего бота сам; администратор — любого
    // бота (в т.ч. чужого) прямо из админ-панели. Встроенных системных
    // ботов (главный ассистент и BotCreator) удалить нельзя — без них
    // сломается часть базового функционала приложения.
    if (!bot || (bot.ownerId !== user.id && !user.isAdmin)) return sendJSON(res, 404, { error: 'Бот не найден' });
    if (bot.id === BOT_ID || bot.id === BOTCREATOR_ID) return sendJSON(res, 400, { error: 'Этого системного бота удалить нельзя' });
    const convs = db.all('conversations').filter((c) => c.type === 'dm' && c.participants.includes(bot.id));
    convs.forEach((c) => {
      broadcastToConversation(c, { type: 'conversation-deleted', conversationId: c.id }, null);
      db.removeManyBy('messages', 'conversationId', c.id);
      removeConvFromAllFolders(c.id);
      db.remove('conversations', c.id);
    });
    db.remove('bots', bot.id);
    db.remove('users', bot.id);
    return sendJSON(res, 200, { ok: true });
  }

  // ---------- Riveo ID: мини-приложение цифрового ID (паспорт/карта) ----------
  // Открытый и полный текст персональных данных наружу не возвращается
  // никогда — только заранее посчитанный маскированный preview (см.
  // riveoPreview/saveRiveoPassport/saveRiveoCard выше). Полноценное
  // "прочитать сохранённое обратно" тут намеренно отсутствует.
  if (pathname === '/api/riveo/me' && method === 'GET') {
    return sendJSON(res, 200, riveoPreview(user.id));
  }
  if (pathname === '/api/riveo/passport' && method === 'POST') {
    const body = await readBody(req);
    const result = saveRiveoPassport(user.id, body);
    if (result.error) return sendJSON(res, 400, { error: result.error });
    return sendJSON(res, 200, { passport: result.preview });
  }
  if (pathname === '/api/riveo/passport' && method === 'DELETE') {
    deleteRiveoPassport(user.id);
    return sendJSON(res, 200, { ok: true });
  }
  if (pathname === '/api/riveo/card' && method === 'POST') {
    const body = await readBody(req);
    const result = saveRiveoCard(user.id, body);
    if (result.error) return sendJSON(res, 400, { error: result.error });
    return sendJSON(res, 200, { card: result.preview });
  }
  if (pathname === '/api/riveo/card' && method === 'DELETE') {
    deleteRiveoCard(user.id);
    return sendJSON(res, 200, { ok: true });
  }

  // ---------- Папки с чатами (персональные для каждого пользователя) ----------
  if (pathname === '/api/folders' && method === 'GET') {
    const folders = db.findManyBy('folders', 'userId', user.id);
    return sendJSON(res, 200, { folders });
  }

  if (pathname === '/api/folders' && method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    if (!name) return sendJSON(res, 400, { error: 'Укажите название папки' });
    const folder = db.insert('folders', {
      id: genId('folder'),
      userId: user.id,
      name,
      convIds: Array.isArray(body.convIds) ? body.convIds : [],
      createdAt: Date.now(),
    });
    return sendJSON(res, 200, { folder });
  }

  const folderMatch = pathname.match(/^\/api\/folders\/([^/]+)$/);
  if (folderMatch && method === 'PATCH') {
    const folder = db.findById('folders', folderMatch[1]);
    if (!folder || folder.userId !== user.id) return sendJSON(res, 404, { error: 'Папка не найдена' });
    const body = await readBody(req);
    const patch = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) return sendJSON(res, 400, { error: 'Пустое название папки' });
      patch.name = name;
    }
    if (body.convIds !== undefined) patch.convIds = Array.isArray(body.convIds) ? body.convIds : [];
    const updated = db.update('folders', folder.id, patch);
    return sendJSON(res, 200, { folder: updated });
  }

  if (folderMatch && method === 'DELETE') {
    const folder = db.findById('folders', folderMatch[1]);
    if (!folder || folder.userId !== user.id) return sendJSON(res, 404, { error: 'Папка не найдена' });
    db.remove('folders', folder.id);
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 404, { error: 'Не найдено' });
}

function enrichConversationAdmin(conv) {
  const out = { ...conv };
  if (conv.type === 'dm') {
    out.title = (conv.participants || []).map((pid) => {
      const u = db.findById('users', pid);
      return u ? u.displayName : '?';
    }).join(' ↔ ');
  } else {
    out.title = conv.name;
  }
  out.messageCount = db.countMessagesBy(conv.id);
  out.lastMessage = decryptMessage(db.findLastBy('messages', 'conversationId', conv.id));
  return out;
}

function enrichConversation(conv, viewerId) {
  const out = { ...conv };
  if (conv.type === 'dm') {
    const otherId = conv.participants.find((p) => p !== viewerId);
    const other = db.findById('users', otherId);
    out.peer = publicUserForViewer(other, viewerId);
    // Отпечаток ключа шифрования ЭТОЙ переписки (см. conversationKeyFingerprint
    // в lib/util.js) — не сам ключ (его показывать нельзя, это и есть
    // секрет), а его безопасный хэш-"отпечаток". У обеих сторон переписки он
    // совпадает (детерминированно порождается из id одной и той же
    // conversations-записи) — можно свериться визуально, как номер
    // безопасности в Signal.
    out.peer.encryptionKeyFingerprint = conversationKeyFingerprint(conv.id);
    // Локальное имя контакта — как этот собеседник подписан именно у меня
    // (например вместо «Саша» → «сыночек»), не видно второй стороне.
    out.peerNickname = (conv.nicknames && conv.nicknames[viewerId]) || '';
    // Если собеседник — бот с подключённым мини-приложением (BotCreator или
    // бот, созданный через него), сообщаем клиенту его конфиг, чтобы
    // показать кнопку мини-приложения в поле ввода.
    if (out.peer && out.peer.isBot) {
      const botRecord = db.findById('bots', otherId);
      out.peer.miniApp = (botRecord && botRecord.miniApp && botRecord.miniApp.enabled && botRecord.miniApp.url)
        ? { url: botRecord.miniApp.url }
        : null;
      out.peer.isBotOwner = !!(botRecord && botRecord.ownerId === viewerId);
    }
  }
  if (conv.type === 'channel' || conv.type === 'group') {
    const room = groupCallRooms.get(conv.id);
    out.groupCallCount = room ? room.size : 0;
  }
  out.lastMessage = decryptMessage(db.findLastBy('messages', 'conversationId', conv.id));
  // Отметки о прочтении (для галочек в личных чатах) + счётчик непрочитанных
  // (для бейджа в списке чатов слева) — считаем прямо в SQLite (COUNT(*)),
  // не поднимая в память и не парся всю историю чата ради этого, как было
  // раньше (см. db.countMessagesBy).
  out.reads = visibleReadsFor(conv, viewerId);
  const myLastRead = (conv.reads && conv.reads[viewerId]) || 0;
  out.unreadCount = db.countMessagesBy(conv.id, { excludeSenderId: viewerId, afterCreatedAt: myLastRead });
  if (conv.pinnedMessageId) {
    const pinned = decryptMessage(db.findById('messages', conv.pinnedMessageId));
    if (pinned) {
      out.pinnedMessage = pinned;
    } else {
      // закреплённое сообщение удалили — тихо снимаем закрепление
      out.pinnedMessage = null;
      out.pinnedMessageId = null;
      db.update('conversations', conv.id, { pinnedMessageId: null });
    }
  } else {
    out.pinnedMessage = null;
  }
  return out;
}

// ---------- Сервер ----------
function requestHandler(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);

  if (pathname.startsWith('/api/')) {
    handleAPI(req, res, pathname, parsed.query).catch((err) => {
      console.error(err);
      sendJSON(res, 500, { error: 'Внутренняя ошибка сервера' });
    });
    return;
  }

  if (pathname.startsWith('/uploads/')) {
    serveStatic(req, res, UPLOADS_DIR, pathname.replace('/uploads/', ''));
    return;
  }

  if (pathname === '/' || pathname === '') {
    serveStatic(req, res, PUBLIC_DIR, '/index.html');
    return;
  }

  // Глубокие ссылки (приглашение в группу/канал, профиль) — это чисто
  // клиентские маршруты в SPA: отдаём index.html, а сам путь разбирает уже
  // app.js на клиенте (см. handleDeepLinkIfPresent).
  if (/^\/j\/[^/]+$/.test(pathname) || /^\/u\/[^/]+$/.test(pathname) || /^\/qr\/[^/]+$/.test(pathname)) {
    serveStatic(req, res, PUBLIC_DIR, '/index.html');
    return;
  }

  serveStatic(req, res, PUBLIC_DIR, pathname);
}

const server = http.createServer(requestHandler);
wss.attach(server);

function localAddrs() {
  const nets = os.networkInterfaces();
  const addrs = [];
  Object.values(nets).forEach((ifaces) => (ifaces || []).forEach((i) => {
    if (i.family === 'IPv4' && !i.internal) addrs.push(i.address);
  }));
  return addrs;
}

const CERT_DIR = path.join(__dirname, 'certs');
const KEY_PATH = path.join(CERT_DIR, 'key.pem');
const CERT_PATH = path.join(CERT_DIR, 'cert.pem');
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
let httpsServer = null;

// Без HTTPS браузер не даёт доступ к камере/микрофону нигде, кроме
// localhost, — значит не работают звонки, голосовые и видео-кружки. Раньше
// это решалось локальным IP + отдельным ручным шагом (node generate-cert.js).
// Теперь, если сертификата ещё нет, сервер при старте пытается сделать это
// сам (тем же openssl, без сторонних сервисов), чтобы это не забывали
// сделать при переезде из локальной сети в интернет. Публичный домен/IP
// можно подсказать переменной PUBLIC_HOST — тогда сертификат будет выписан и
// на него тоже.
if (!fs.existsSync(KEY_PATH) || !fs.existsSync(CERT_PATH)) {
  try {
    const { generateCert } = require('./generate-cert');
    const extra = (process.env.PUBLIC_HOST || process.env.PUBLIC_IP || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    generateCert(extra, { quiet: true });
  } catch (e) {
    console.error('⚠️  Автоматическая генерация HTTPS-сертификата не удалась:', e.message);
  }
}

if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) {
  try {
    httpsServer = https.createServer({
      key: fs.readFileSync(KEY_PATH),
      cert: fs.readFileSync(CERT_PATH),
    }, requestHandler);
    wss.attach(httpsServer);
  } catch (e) {
    console.error('⚠️  Не удалось запустить HTTPS (проверьте certs/key.pem и certs/cert.pem):', e.message);
    httpsServer = null;
  }
}

// ---------- Автоматический доверенный HTTPS-сертификат (Let's Encrypt) ----------
// Самоподписанный сертификат выше ВСЕГДА работает как надёжный запасной
// вариант — сервер и звонки работают в любом случае. Но браузер каждый раз
// показывает предупреждение "соединение не защищено", и пользователям
// приходится вручную кликать "всё равно перейти". Здесь — попытка
// автоматически получить НАСТОЯЩИЙ, доверенный браузерами сертификат от
// Let's Encrypt, полностью самостоятельно и без единого шага руками: ни
// ключей, ни аккаунтов, ни ручного certbot/сторонних сервисов — см.
// lib/acme.js. Если публичного домена нет (только PUBLIC_HOST/публичный IP),
// используется бесплатный wildcard-DNS sslip.io, чтобы превратить голый IP в
// настоящее имя (203.0.113.10 → 203-0-113-10.sslip.io) — Let's Encrypt не
// умеет выдавать сертификаты на голые IP, а покупать домен ради этого не
// нужно. Если порт 80 недоступен снаружи или что-то ещё пошло не так —
// сервер просто продолжает работать на самоподписанном, как и раньше.
// Отключить эту попытку совсем можно переменной ASTERIA_DISABLE_AUTO_HTTPS=1.
const ACME_DIR = path.join(PERSIST_ROOT, 'acme');
const ACME_CERT_PATH = path.join(ACME_DIR, 'cert.pem');
const ACME_KEY_PATH = path.join(ACME_DIR, 'key.pem');
const ACME_ACCOUNT_KEY_PATH = path.join(ACME_DIR, 'account-key.pem');
const ACME_RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000; // Let's Encrypt выдаёт на 90 дней — обновляем за 30 до истечения
const acmeChallengeResponses = new Map(); // token -> keyAuthorization, для /.well-known/acme-challenge/:token
let acmeChallengeServer = null;

function certExpiryDate(certPath) {
  try {
    const out = execSync(`openssl x509 -in "${certPath}" -noout -enddate`).toString();
    const m = out.match(/notAfter=(.+)/);
    return m ? new Date(m[1].trim()) : null;
  } catch (e) {
    return null;
  }
}

// Let's Encrypt всегда проверяет http-01 challenge именно на порту 80 (это
// не настраивается) — поэтому под это нужен отдельный слушатель, даже если
// сам сервер обычно работает на другом порту. Если порт занят или нет прав
// на него (не root) — тихо отступаем, ничего не ломая.
function startAcmeChallengeServer() {
  if (acmeChallengeServer) return Promise.resolve(true);
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const m = req.url.match(/^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]+)$/);
      if (m && acmeChallengeResponses.has(m[1])) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(acmeChallengeResponses.get(m[1]));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    srv.once('error', (e) => {
      console.log(`ℹ️  Автоматический доверенный HTTPS: порт 80 недоступен (${e.code}) — это нормально, если он занят или нет прав root. Самоподписанный сертификат продолжает работать как обычно.`);
      resolve(false);
    });
    srv.listen(80, '0.0.0.0', () => {
      acmeChallengeServer = srv;
      resolve(true);
    });
  });
}

function applyAcmeCert() {
  if (!httpsServer) return;
  try {
    httpsServer.setSecureContext({ key: fs.readFileSync(ACME_KEY_PATH), cert: fs.readFileSync(ACME_CERT_PATH) });
  } catch (e) {
    console.error('⚠️  Не удалось применить полученный доверенный сертификат:', e.message);
  }
}

async function tryAutoHttps() {
  if (process.env.ASTERIA_DISABLE_AUTO_HTTPS === '1') return;
  if (!httpsServer) return; // самоподписанный HTTPS не поднялся — обновлять нечего
  try {
    let domain = (process.env.PUBLIC_HOST || '').split(',')[0].trim() || null;
    if (!domain && /^\d{1,3}(\.\d{1,3}){3}$/.test(TURN_HOST || '')) {
      // Публичный IP уже определён (через STUN, см. startTurnServer) — своего
      // домена нет, заворачиваем через sslip.io, чтобы не просить админа
      // ничего покупать/настраивать вручную.
      domain = TURN_HOST.split('.').join('-') + '.sslip.io';
    } else if (domain && /^\d{1,3}(\.\d{1,3}){3}$/.test(domain)) {
      domain = domain.split('.').join('-') + '.sslip.io';
    }
    if (!domain || domain === 'localhost') {
      return; // нет публичного адреса — автоматический HTTPS тут просто не имеет смысла (локальная сеть)
    }

    if (fs.existsSync(ACME_CERT_PATH) && fs.existsSync(ACME_KEY_PATH)) {
      const expiry = certExpiryDate(ACME_CERT_PATH);
      if (expiry && (expiry.getTime() - Date.now()) > ACME_RENEW_BEFORE_MS) {
        applyAcmeCert();
        printTrustedUrlBanner(domain);
        return; // уже есть свежий сертификат — Let's Encrypt лишний раз не дёргаем
      }
    }

    const challengeServerUp = await startAcmeChallengeServer();
    if (!challengeServerUp) return;

    console.log(`🔒 Пытаюсь автоматически получить доверенный HTTPS-сертификат от Let's Encrypt для ${domain}…`);
    const { AcmeClient } = require('./lib/acme');
    const client = new AcmeClient({
      accountKeyPath: ACME_ACCOUNT_KEY_PATH,
      directoryUrl: process.env.ASTERIA_ACME_DIRECTORY_URL || undefined,
    });
    const { certPem, keyPem } = await client.obtainCertificate({
      domain,
      registerChallenge: (token, keyAuth) => acmeChallengeResponses.set(token, keyAuth),
      unregisterChallenge: (token) => acmeChallengeResponses.delete(token),
    });

    fs.mkdirSync(ACME_DIR, { recursive: true });
    fs.writeFileSync(ACME_CERT_PATH, certPem);
    fs.writeFileSync(ACME_KEY_PATH, keyPem);
    applyAcmeCert();
    printTrustedUrlBanner(domain);
  } catch (e) {
    console.log(`ℹ️  Не удалось автоматически получить доверенный HTTPS-сертификат (не критично — сервер продолжает работать на самоподписанном): ${e.message}`);
  }
}

// ВАЖНО: сертификат Let's Encrypt выписан на ИМЯ (домен/sslip.io), а не на
// голый IP-адрес — это принципиальное ограничение самого протокола ACME,
// обойти его нельзя. Значит, если открывать сервер по голому IP
// (https://46.8.227.207:3443), браузер по-прежнему будет считать соединение
// "незащищённым", даже когда сертификат настоящий и валидный — потому что
// имя в адресной строке не совпадает с именем в сертификате. Пользоваться
// нужно именно этим адресом — печатаем его отдельно и заметно, чтобы это
// было не потерять среди остальных строк лога.
function printTrustedUrlBanner(domain) {
  console.log('');
  console.log(`🔒✅ Доверенный адрес (без предупреждений браузера): https://${domain}:${HTTPS_PORT}`);
  console.log('   Раздавайте пользователям именно этот адрес — не голый IP. По голому IP');
  console.log('   браузер будет показывать "не защищено", даже с настоящим сертификатом:');
  console.log('   сертификат Let\'s Encrypt выписывается на имя, а не на IP-адрес.');
  console.log('');
}
// Первая попытка — после того как определён публичный адрес (см.
// startTurnServer ниже), дальше раз в сутки (заодно проверяет и продлевает
// истекающий сертификат).
setInterval(tryAutoHttps, 24 * 60 * 60 * 1000);

// ---------- TURN/STUN (нужен, чтобы звонки соединялись через интернет, а не только в LAN) ----------
// Секрет для выдачи временных TURN-креденшлов — генерируется один раз и
// хранится рядом с базой данных, как и остальные локальные данные сервера.
const TURN_SECRET_PATH = path.join(PERSIST_ROOT, 'turn-secret.txt');
function getOrCreateTurnSecret() {
  try {
    if (fs.existsSync(TURN_SECRET_PATH)) return fs.readFileSync(TURN_SECRET_PATH, 'utf8').trim();
  } catch (e) {}
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    if (!fs.existsSync(path.dirname(TURN_SECRET_PATH))) fs.mkdirSync(path.dirname(TURN_SECRET_PATH), { recursive: true });
    fs.writeFileSync(TURN_SECRET_PATH, secret);
  } catch (e) {}
  return secret;
}
const TURN_SECRET = getOrCreateTurnSecret();
const TURN_PORT = Number(process.env.TURN_PORT) || 3478;
// Адрес, который сообщаем клиентам как адрес STUN/TURN-сервера. По умолчанию —
// первый локальный (не loopback) IP; если сервер стоит за NAT/в облаке, где
// внешний адрес отличается от адреса сетевого интерфейса, задайте его явно
// переменной окружения PUBLIC_HOST (например PUBLIC_HOST=messenger.example.com
// или PUBLIC_HOST=203.0.113.10). Иначе ниже пробуем определить его сами через STUN.
let TURN_HOST = process.env.PUBLIC_HOST || process.env.PUBLIC_IP || localAddrs()[0] || 'localhost';
let turnServerReady = null;

async function startTurnServer() {
  let publicIp = process.env.PUBLIC_HOST || process.env.PUBLIC_IP || null;
  if (!publicIp) {
    // Лучший эффорт: спрашиваем публичный STUN-сервер, какой у нас "снаружи"
    // виден адрес, и используем его и как TURN_HOST, и как relay-адрес.
    // Если интернета нет (чисто локальный запуск) — просто остаёмся на LAN IP.
    try {
      const discovered = await require('./lib/mini-turn').stunDiscover();
      if (discovered && discovered.address) {
        publicIp = discovered.address;
        TURN_HOST = discovered.address;
      }
    } catch (e) { /* offline/LAN — не страшно, останемся на локальном адресе */ }
  } else {
    TURN_HOST = publicIp;
  }
  try {
    await createTurnServer({ secret: TURN_SECRET, port: TURN_PORT, publicIp, log: (m) => console.error('TURN:', m) });
    console.log(`🧊 TURN/STUN сервер запущен на порту ${TURN_PORT} (адрес для клиентов: ${TURN_HOST})`);
    console.log('   Если сервер работает за NAT/маршрутизатором/облаком — убедитесь, что порт');
    console.log(`   ${TURN_PORT}/UDP проброшен наружу, иначе звонки через интернет не будут соединяться.`);
  } catch (e) {
    console.error('⚠️  Не удалось запустить TURN/STUN сервер (звонки за пределами LAN могут не работать):', e.message);
  }
}
turnServerReady = startTurnServer();
turnServerReady.then(() => tryAutoHttps()).catch(() => {});

// ---------- Фоновое обслуживание: чистка неиспользуемого, экономия диска ----------
//
// На слабом сервере (мало ОЗУ, мало диска) особенно важно не копить мусор:
// удалённые сообщения/сторис раньше оставляли сами файлы (фото, видео,
// голосовые) на диске НАВСЕГДА, даже когда на них никто больше не
// ссылается. Здесь — разовая (при старте) и затем периодическая уборка.

// Свежие файлы (моложе этого времени) не трогаем НИКОГДА, даже если они
// пока ни на что не похожи — защита от гонки: файл мог только что
// загрузиться через /api/upload, а само сообщение с ссылкой на него ещё не
// успело долететь и сохраниться в базу.
const UPLOAD_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000; // 24 часа

// Собирает множество всех "/uploads/..." URL, которые ещё где-либо
// используются. messages — самая большая таблица, поэтому для неё берём
// только нужное поле (см. distinctFieldValues в lib/db.js), не поднимая в
// память сами сообщения. Остальные таблицы малы (ограничены числом
// пользователей/чатов/историй, а не сообщений) — грузить их целиком безопасно.
function collectReferencedUploadUrls() {
  const urls = new Set();
  const add = (u) => { if (u && typeof u === 'string' && u.startsWith('/uploads/')) urls.add(u); };
  db.distinctFieldValues('messages', 'mediaUrl').forEach(add);
  db.all('users').forEach((u) => { add(u.avatar); add(u.chatWallpaper); });
  db.all('conversations').forEach((c) => add(c.avatar));
  db.all('bots').forEach((b) => add(b.avatar));
  db.all('stories').forEach((s) => add(s.mediaUrl));
  const banner = readBanner();
  if (banner) add(banner.imageUrl);
  return urls;
}

function sweepOrphanUploads() {
  try {
    const referenced = collectReferencedUploadUrls();
    const now = Date.now();
    let removedCount = 0;
    let removedBytes = 0;

    function walk(dir, urlPrefix) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const url = urlPrefix + entry.name;
        if (entry.isDirectory()) { walk(fullPath, url + '/'); continue; }
        if (referenced.has(url)) continue;
        let st;
        try { st = fs.statSync(fullPath); } catch (e) { continue; }
        if (now - st.mtimeMs < UPLOAD_ORPHAN_GRACE_MS) continue; // слишком свежий — пропускаем на всякий случай
        try {
          fs.unlinkSync(fullPath);
          removedCount++;
          removedBytes += st.size;
        } catch (e) { /* не критично — попробуем в следующий раз */ }
      }
    }

    walk(UPLOADS_DIR, '/uploads/');
    if (removedCount > 0) {
      console.log(`🧹 Очистка загрузок: удалено ${removedCount} неиспользуемых файлов, освобождено ${(removedBytes / (1024 * 1024)).toFixed(1)} МБ.`);
    }
  } catch (e) {
    console.error('⚠️  Ошибка при очистке неиспользуемых загрузок (не критично):', e.message);
  }
}

// Просроченные сторис (по TTL) и так уже не показываются в /api/stories, но
// сами строки и файлы раньше оставались в базе навсегда — убираем и то, и
// другое, чтобы таблица stories и диск не росли бесконечно.
function sweepExpiredStories() {
  try {
    const now = Date.now();
    let removed = 0;
    db.all('stories').forEach((s) => {
      const author = db.findById('users', s.userId);
      const ttl = author && isPremiumActive(author) ? PREMIUM_STORY_TTL_MS : REGULAR_STORY_TTL_MS;
      if (s.createdAt <= now - ttl) {
        db.remove('stories', s.id);
        if (s.mediaUrl) deleteUploadedFile(s.mediaUrl);
        removed++;
      }
    });
    if (removed > 0) console.log(`🧹 Убрано просроченных сторис: ${removed}.`);
  } catch (e) {
    console.error('⚠️  Ошибка при очистке просроченных сторис (не критично):', e.message);
  }
}

function runMaintenanceSweep() {
  sweepExpiredStories();
  sweepOrphanUploads();
  db.incrementalVacuum(500); // небольшими порциями возвращаем место от удалённого на диск
}

// Первый проход — через минуту после старта (не соревнуемся за диск/CPU с
// самим запуском сервера), дальше — раз в сутки. incrementalVacuum при этом
// дополнительно подёргиваем почаще (раз в час) небольшими порциями, чтобы
// место с диска освобождалось постепенно, а не одним долгим рывком раз в день.
setTimeout(runMaintenanceSweep, 60 * 1000);
setInterval(runMaintenanceSweep, 24 * 60 * 60 * 1000);
setInterval(() => db.incrementalVacuum(200), 60 * 60 * 1000);

server.listen(PORT, '0.0.0.0', () => {
  const addrs = localAddrs();
  console.log('\n🚀 Asteria запущена!');
  console.log(`   Локально:      http://localhost:${PORT}`);
  addrs.forEach((a) => console.log(`   В сети (LAN):  http://${a}:${PORT}`));

  if (httpsServer) {
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`\n🔒 HTTPS (самоподписанный сертификат):`);
      console.log(`   Локально:      https://localhost:${HTTPS_PORT}`);
      addrs.forEach((a) => console.log(`   В сети (LAN):  https://${a}:${HTTPS_PORT}`));
      console.log('   При первом заходе браузер покажет предупреждение "Соединение не защищено" —');
      console.log('   это нормально для самоподписанного сертификата, нажмите "Дополнительно" → "Всё равно перейти".');
    });
  } else {
    console.log('\n💡 HTTPS не запущен: сертификат не найден. Чтобы включить HTTPS (нужно для звонков и');
    console.log('   микрофона/камеры на телефонах и не-localhost адресах), выполните один раз:');
    console.log('       node generate-cert.js');
    console.log('   и перезапустите сервер.');
  }

  console.log('\nОстановить сервер: Ctrl+C\n');
});
