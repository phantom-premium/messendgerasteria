'use strict';
// Уборка данных, которые остаются после звонков.
//
// Что именно копится (проверено по коду server.js):
//  1) записи таблицы `calls` — по одной на каждый звонок, навсегда;
//  2) у звонков, которые «повисли» (звонящий закрыл вкладку, сервер
//     перезапустили, пропало соединение), остаётся статус ringing/ongoing и
//     тяжёлое поле sdp (несколько КБ текста на звонок), хотя звонка давно нет.
//
// Модуль трогает ТОЛЬКО таблицу `calls`: ни сообщения, ни загруженные файлы
// (/uploads), ни чаты, ни пользователей он не удаляет и не читает.

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULTS = {
  // Как долго хранить ЗАВЕРШЁННЫЕ звонки в истории. 0 — не удалять никогда.
  retentionMs: 30 * DAY_MS,
  // Звонок «звонит» дольше этого — на самом деле давно потерян.
  staleRingingMs: 10 * 60 * 1000,
  // Разговор 1:1 длится дольше этого без «положил трубку» — потерян.
  staleAnsweredMs: 12 * 60 * 60 * 1000,
  // Групповой звонок «идёт», но комнаты на сервере уже нет (рестарт и т.п.).
  staleGroupMs: 5 * 60 * 1000,
};

const FINISHED = new Set(['ended', 'missed', 'declined']);

/**
 * @param db   модуль lib/db.js (нужны all / update / remove)
 * @param opts { now, activeCallIds:Set<string>, retentionMs, ... }
 *             activeCallIds — id записей, чьи групповые комнаты прямо сейчас живы;
 *             такие записи не трогаются ни при каких условиях.
 * @returns { finalized, stripped, deleted }
 */
function sweepCallRecords(db, opts = {}) {
  const o = { ...DEFAULTS, now: Date.now(), activeCallIds: new Set(), ...opts };
  const result = { finalized: 0, stripped: 0, deleted: 0 };
  const calls = db.all('calls');

  for (const c of calls) {
    if (!c || !c.id) continue;
    if (o.activeCallIds.has(c.id)) continue; // идёт прямо сейчас

    const startedAt = c.startedAt || 0;
    let patch = null;

    // 1) «Повисшие» звонки закрываем (запись остаётся — как пропущенный/завершённый).
    if (c.mode === 'group' && c.status === 'ongoing' && startedAt && o.now - startedAt > o.staleGroupMs) {
      patch = { status: 'ended', endedAt: startedAt };
    } else if (c.mode === '1:1' && c.status === 'ringing' && startedAt && o.now - startedAt > o.staleRingingMs) {
      patch = { status: 'missed', endedAt: startedAt };
    } else if (c.mode === '1:1' && c.status === 'answered' && !c.endedAt
               && (c.answeredAt || startedAt) && o.now - (c.answeredAt || startedAt) > o.staleAnsweredMs) {
      patch = { status: 'ended', endedAt: c.answeredAt || startedAt };
    }
    // endedAt для «повисших» берём из времени самого звонка, а не «сейчас»:
    // реальный момент завершения неизвестен, а так старая запись не «молодеет»
    // и честно доживает до срока хранения.
    const status = patch ? patch.status : c.status;

    // 2) SDP нужен только пока звонок ещё звонит (resendRingingCallsTo).
    if (status !== 'ringing' && c.sdp !== undefined) {
      patch = Object.assign(patch || {}, { sdp: undefined });
      result.stripped++;
    }
    if (patch) {
      if (patch.status) result.finalized++;
      db.update('calls', c.id, patch);
    }

    // 3) Старые ЗАВЕРШЁННЫЕ звонки удаляем из истории.
    if (o.retentionMs > 0) {
      const finishedAt = c.endedAt || (patch && patch.endedAt) || 0;
      const isFinished = FINISHED.has(status) || !!finishedAt;
      const refTs = finishedAt || startedAt;
      if (isFinished && refTs && o.now - refTs > o.retentionMs) {
        if (db.remove('calls', c.id)) result.deleted++;
      }
    }
  }
  return result;
}

module.exports = { sweepCallRecords, DEFAULTS };
