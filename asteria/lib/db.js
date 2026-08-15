'use strict';
// Хранилище на SQLite (встроенный модуль node:sqlite, доступен с Node.js 22.5+,
// экспериментальный, но не требует установки внешних пакетов).
// Каждая "коллекция" — это таблица с колонками id (TEXT PRIMARY KEY) и data (JSON).
// Так сохраняется тот же простой интерфейс (all/insert/update/remove/findById),
// но данные теперь лежат в настоящей БД: поддерживают конкурентный доступ,
// не боятся резкого обрыва записи, и с ними проще расти дальше (индексы, SQL-запросы).
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const os = require('os');

// Все пользовательские данные (аккаунты, переписки, звонки и т.д.) хранятся
// ВНЕ папки проекта — в домашней директории пользователя. Так они переживают
// полную замену папки asteria/ на новую версию (обновление кода не трогает
// эту директорию). Расположение можно переопределить переменной окружения
// ASTERIA_DATA_DIR (например, чтобы вынести данные на отдельный диск/раздел).
const PERSIST_ROOT = process.env.ASTERIA_DATA_DIR || path.join(os.homedir(), '.asteria-data');
const DATA_DIR = path.join(PERSIST_ROOT, 'db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Одноразовая миграция: в старых версиях база лежала прямо внутри папки
// проекта (asteria/data/asteria.db) и терялась при каждой замене папки на
// новую версию. Если по новому "постоянному" пути базы ещё нет, а по
// старому — есть, переносим её один раз автоматически.
const LEGACY_DATA_DIR = path.join(__dirname, '..', 'data');
const NEW_DB_PATH = path.join(DATA_DIR, 'asteria.db');
if (!fs.existsSync(NEW_DB_PATH) && fs.existsSync(LEGACY_DATA_DIR)) {
  fs.readdirSync(LEGACY_DATA_DIR)
    .filter((f) => f.startsWith('asteria.db'))
    .forEach((f) => fs.copyFileSync(path.join(LEGACY_DATA_DIR, f), path.join(DATA_DIR, f)));
  if (fs.existsSync(NEW_DB_PATH)) {
    console.log('📦 База данных перенесена из старого расположения в', DATA_DIR);
  }
}

const DB_PATH = path.join(DATA_DIR, 'asteria.db');
const db = new DatabaseSync(DB_PATH);

// WAL — чтобы чтение и запись не блокировали друг друга при нескольких пользователях одновременно
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Настройки под слабый сервер (мало ОЗУ, мало диска):
// - synchronous=NORMAL — вместе с WAL это стандартная рекомендуемая связка:
//   почти так же безопасно при сбое, как FULL, но заметно быстрее на запись
//   (не ждём fsync на каждую мелкую операцию).
// - mmap_size=0 — отключаем memory-mapped I/O: он экономит копирования, но
//   на глаз операционной системы выглядит как резидентная память процесса,
//   а при 1 ГБ ОЗУ это может спровоцировать OOM-killer раньше времени.
//   Предсказуемое потребление памяти важнее небольшого выигрыша скорости.
// - temp_store=FILE — временные данные больших сортировок/группировок уходят
//   на диск, а не раздувают кучу Node — тоже ради стабильности при 1 ГБ ОЗУ.
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA mmap_size = 0;');
db.exec('PRAGMA temp_store = FILE;');

// auto_vacuum: без него SQLite после DELETE просто помечает страницы
// свободными внутри файла, но сам файл на диске НЕ уменьшается — при 20 ГБ
// диска и растущей истории сообщений/звонков это через какое-то время
// становится ощутимо. Включить auto_vacuum на уже существующей базе можно
// только через одноразовый VACUUM (это единственный раз, когда придётся
// пересобрать весь файл целиком — дальше страницы будут освобождаться
// постепенно сами через PRAGMA incremental_vacuum, см. ниже, без больших
// разовых пауз).
try {
  const currentMode = db.prepare('PRAGMA auto_vacuum').get();
  if (!currentMode || currentMode.auto_vacuum === 0) {
    console.log('🗜️  Первичная настройка сжатия базы данных (auto_vacuum) — может занять какое-то время при большой базе…');
    db.exec('PRAGMA auto_vacuum = INCREMENTAL;');
    db.exec('VACUUM;');
    console.log('🗜️  Готово.');
  }
} catch (e) {
  console.error('⚠️  Не удалось включить auto_vacuum (не критично, БД продолжает работать как обычно):', e.message);
}

const TABLES = ['users', 'sessions', 'conversations', 'messages', 'stories', 'folders', 'calls', 'bots', 'pushTokens', 'riveoProfiles'];

TABLES.forEach((t) => {
  db.exec(`CREATE TABLE IF NOT EXISTS ${t} (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at INTEGER
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_created_at ON ${t}(created_at)`);
});
// Отдельный индекс для быстрой выборки сообщений по чату (по JSON-полю conversationId)
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(json_extract(data, '$.conversationId'))`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(json_extract(data, '$.username'))`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(json_extract(data, '$.token'))`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(json_extract(data, '$.userId'))`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(json_extract(data, '$.userId'))`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(json_extract(data, '$.ownerId'))`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_bots_username ON bots(json_extract(data, '$.username'))`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_pushtokens_user ON pushTokens(json_extract(data, '$.userId'))`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_pushtokens_token ON pushTokens(json_extract(data, '$.token'))`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(json_extract(data, '$.calleeId'))`);

function assertTable(name) {
  if (!TABLES.includes(name)) throw new Error(`Неизвестная таблица: ${name}`);
}

const stmtCache = {};
function prep(sql) {
  if (!stmtCache[sql]) stmtCache[sql] = db.prepare(sql);
  return stmtCache[sql];
}

function all(name) {
  assertTable(name);
  const rows = prep(`SELECT data FROM ${name} ORDER BY created_at ASC`).all();
  return rows.map((r) => JSON.parse(r.data));
}

function findById(name, id) {
  assertTable(name);
  if (!id) return null;
  const row = prep(`SELECT data FROM ${name} WHERE id = ?`).get(id);
  return row ? JSON.parse(row.data) : null;
}

function insert(name, obj) {
  assertTable(name);
  if (!obj.id) throw new Error('insert: объект должен иметь поле id');
  prep(`INSERT INTO ${name} (id, data, created_at) VALUES (?, ?, ?)`)
    .run(obj.id, JSON.stringify(obj), obj.createdAt || Date.now());
  return obj;
}

function update(name, id, patch) {
  assertTable(name);
  const current = findById(name, id);
  if (!current) return null;
  const merged = Object.assign({}, current, patch);
  prep(`UPDATE ${name} SET data = ? WHERE id = ?`).run(JSON.stringify(merged), id);
  return merged;
}

function remove(name, id) {
  assertTable(name);
  const res = prep(`DELETE FROM ${name} WHERE id = ?`).run(id);
  return res.changes > 0;
}

// Специальный хелпер: найти сессию/пользователя и т.п. по произвольному JSON-полю,
// без выгрузки всей таблицы в память (используется для поиска по username, token и т.д.)
function findOneBy(name, field, value) {
  assertTable(name);
  const row = prep(`SELECT data FROM ${name} WHERE json_extract(data, '$.' || ?) = ?`).get(field, value);
  return row ? JSON.parse(row.data) : null;
}

function findManyBy(name, field, value) {
  assertTable(name);
  const rows = prep(`SELECT data FROM ${name} WHERE json_extract(data, '$.' || ?) = ? ORDER BY created_at ASC`).all(field, value);
  return rows.map((r) => JSON.parse(r.data));
}

// Постраничная выборка по полю, с сортировкой от новых к старым и лимитом —
// нужна там, где записей может накопиться очень много (в первую очередь —
// сообщения в чате) и незачем каждый раз поднимать в память и отдавать по
// сети всю историю целиком. beforeCreatedAt — курсор ("отдай записи старше
// вот этой метки времени"), без него отдаёт самые свежие. Возвращает
// {items, hasMore} — items уже в естественном хронологическом порядке
// (от старых к новым), hasMore — есть ли ещё более старые записи за
// пределами этой страницы.
function findPageBy(name, field, value, { beforeCreatedAt, limit } = {}) {
  assertTable(name);
  const lim = Math.max(1, Math.min(200, Number(limit) || 40));
  const fetchLim = lim + 1; // на одну больше — чтобы понять, есть ли ещё, без отдельного COUNT(*)
  const rows = beforeCreatedAt
    ? prep(`SELECT data FROM ${name} WHERE json_extract(data, '$.' || ?) = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`)
      .all(field, value, Number(beforeCreatedAt), fetchLim)
    : prep(`SELECT data FROM ${name} WHERE json_extract(data, '$.' || ?) = ? ORDER BY created_at DESC LIMIT ?`)
      .all(field, value, fetchLim);
  const hasMore = rows.length > lim;
  const page = hasMore ? rows.slice(0, lim) : rows;
  const items = page.map((r) => JSON.parse(r.data)).reverse();
  return { items, hasMore };
}

// Последняя (по created_at) запись с данным значением JSON-поля — например,
// последнее сообщение чата для превью в списке слева. Раньше для этого
// поднимали в память и разбирали ВСЮ историю чата целиком (см. историю
// изменений) ради одного-единственного сообщения — на чате с большой
// историей это на слабом сервере превращалось в заметные секунды задержки
// на каждое открытие списка чатов. ORDER BY ... LIMIT 1 использует тот же
// индекс, что и остальная пагинация, и не трогает остальные строки вовсе.
function findLastBy(name, field, value) {
  assertTable(name);
  const row = prep(`SELECT data FROM ${name} WHERE json_extract(data, '$.' || ?) = ? ORDER BY created_at DESC LIMIT 1`).get(field, value);
  return row ? JSON.parse(row.data) : null;
}

// Считает сообщения в чате прямо в SQLite (COUNT(*)), без выгрузки и
// разбора самих сообщений — нужен и для messageCount в админке, и для
// счётчика непрочитанных (excludeSenderId — не считать свои же сообщения,
// afterCreatedAt — только новее последней прочитанной отметки).
function countMessagesBy(conversationId, { excludeSenderId, afterCreatedAt } = {}) {
  let sql = "SELECT COUNT(*) AS c FROM messages WHERE json_extract(data, '$.conversationId') = ?";
  const params = [conversationId];
  if (excludeSenderId) { sql += " AND json_extract(data, '$.senderId') != ?"; params.push(excludeSenderId); }
  if (afterCreatedAt !== undefined && afterCreatedAt !== null) { sql += ' AND created_at > ?'; params.push(Number(afterCreatedAt)); }
  const row = prep(sql).get(...params);
  return row ? row.c : 0;
}

function removeManyBy(name, field, value) {
  assertTable(name);
  const res = prep(`DELETE FROM ${name} WHERE json_extract(data, '$.' || ?) = ?`).run(field, value);
  return res.changes;
}

// Возвращает уникальные значения ОДНОГО JSON-поля по всей таблице, не
// загружая сами объекты в память — только это поле для каждой строки.
// Нужно для лёгких по памяти фоновых задач на большой таблице (например,
// сверка списка ещё используемых файлов при очистке "осиротевших"
// загрузок — незачем поднимать в память все сообщения целиком ради одного
// поля mediaUrl у каждого).
function distinctFieldValues(name, field) {
  assertTable(name);
  const rows = prep(`SELECT DISTINCT json_extract(data, '$.' || ?) AS v FROM ${name} WHERE json_extract(data, '$.' || ?) IS NOT NULL`)
    .all(field, field);
  return rows.map((r) => r.v);
}

// Небольшими порциями постепенно возвращает операционной системе место от
// удалённых строк (см. auto_vacuum=INCREMENTAL выше) — без этого файл базы
// на диске только растёт и никогда не уменьшается, даже если удалить
// половину сообщений. Порция маленькая специально, чтобы вызов был быстрым
// и не подвешивал сервер — предполагается дергать его периодически
// (см. setInterval в server.js), а не одним большим проходом.
function incrementalVacuum(pages = 200) {
  try {
    db.exec(`PRAGMA incremental_vacuum(${Number(pages) | 0});`);
  } catch (e) {
    console.error('⚠️  incrementalVacuum: ошибка (не критично):', e.message);
  }
}

module.exports = { all, insert, update, remove, findById, findOneBy, findManyBy, findPageBy, findLastBy, countMessagesBy, removeManyBy, distinctFieldValues, incrementalVacuum };
