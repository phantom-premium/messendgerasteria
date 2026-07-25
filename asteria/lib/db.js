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

const TABLES = ['users', 'sessions', 'conversations', 'messages', 'stories', 'folders', 'calls', 'bots', 'pushTokens'];

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
db.exec(`CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(json_extract(data, '$.userId'))`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(json_extract(data, '$.ownerId'))`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_bots_username ON bots(json_extract(data, '$.username'))`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_pushtokens_user ON pushTokens(json_extract(data, '$.userId'))`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_pushtokens_token ON pushTokens(json_extract(data, '$.token'))`);

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

function removeManyBy(name, field, value) {
  assertTable(name);
  const res = prep(`DELETE FROM ${name} WHERE json_extract(data, '$.' || ?) = ?`).run(field, value);
  return res.changes;
}

module.exports = { all, insert, update, remove, findById, findOneBy, findManyBy, removeManyBy };
