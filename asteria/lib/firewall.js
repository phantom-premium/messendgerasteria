'use strict';
// Best-effort автоматическое открытие нужных портов в файрволе ОС при
// старте сервера. Смысл: очень многие люди просто разворачивают проект на
// VPS/в облаке и не знают (и не должны знать), что такое "проброс портов" —
// а многие готовые образы систем (Ubuntu на DigitalOcean/AWS и т.п.)
// поставляются с ufw/firewalld, включённым и блокирующим всё лишнее по
// умолчанию. Раз уж сервер и так своими руками поднимает TURN и слушает
// нужные порты — он же может и попросить файрвол ОС их пропускать, вместо
// того чтобы просто написать в консоль "пробросьте порты" и оставить
// человека наедине с незнакомым словом.
//
// ВАЖНО, и это НЕЛЬЗЯ обойти кодом: если сервер физически стоит дома за
// обычным Wi-Fi-роутером (NAT), проброс портов делается в веб-панели самого
// роутера, а не на этой машине — туда ни один процесс на сервере доступа не
// имеет. То же самое с "облачным" файрволом провайдера (AWS Security
// Groups, DigitalOcean/Timeweb Cloud Firewall и т.п.) — это отдельная
// настройка в панели хостинга, вне операционной системы сервера, и её тоже
// не открыть изнутри. Этот модуль решает только файрвол ОС ВНУТРИ сервера
// (ufw/firewalld/iptables) — самую частую причину проблемы на "чистом" VPS
// с публичным IP, куда просто зашли по SSH и запустили `node server.js`.

const { execSync } = require('child_process');

function run(cmd) {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).toString();
}

function commandExists(cmd) {
  try { run(`command -v ${cmd}`); return true; } catch (e) { return false; }
}

function isRoot() {
  try { return typeof process.getuid === 'function' && process.getuid() === 0; } catch (e) { return false; }
}

// rules: [{ port, proto }] или [{ portStart, portEnd, proto }]
function portSpec(rule) {
  return rule.portStart != null ? `${rule.portStart}:${rule.portEnd}` : `${rule.port}`;
}

function tryUfw(rules, log) {
  if (!commandExists('ufw')) return false;
  let status;
  try { status = run('ufw status'); } catch (e) { return false; }
  if (!/Status:\s*active/i.test(status)) {
    // ufw установлен, но выключен — ничего не блокирует, открывать нечего,
    // но и включать его самим не будем (это осознанный выбор владельца сервера).
    log('ufw установлен, но не активен — пропускаем (файрвол ОС ничего не блокирует).');
    return true;
  }
  let ok = true;
  for (const r of rules) {
    const spec = portSpec(r);
    try {
      run(`ufw allow ${spec}/${r.proto}`);
      log(`ufw: разрешён порт ${spec}/${r.proto}`);
    } catch (e) {
      ok = false;
      log(`ufw: не удалось разрешить порт ${spec}/${r.proto} (${e.message.split('\n')[0]})`);
    }
  }
  return ok;
}

function tryFirewalld(rules, log) {
  if (!commandExists('firewall-cmd')) return false;
  let active;
  try { active = run('firewall-cmd --state'); } catch (e) { return false; }
  if (!/running/i.test(active)) {
    log('firewalld установлен, но не запущен — пропускаем.');
    return true;
  }
  let changed = false;
  for (const r of rules) {
    const spec = portSpec(r);
    try {
      run(`firewall-cmd --permanent --add-port=${spec}/${r.proto}`);
      log(`firewalld: разрешён порт ${spec}/${r.proto}`);
      changed = true;
    } catch (e) {
      log(`firewalld: не удалось разрешить порт ${spec}/${r.proto} (${e.message.split('\n')[0]})`);
    }
  }
  if (changed) {
    try { run('firewall-cmd --reload'); } catch (e) { /* не критично */ }
  }
  return true;
}

// Прямой iptables — самый универсальный вариант (стоит почти везде на
// Linux), но правила по умолчанию НЕ переживают перезагрузку сервера без
// отдельного пакета (iptables-persistent/netfilter-persistent), поэтому
// используется только как последний fallback, если нет ни ufw, ни firewalld.
function tryIptables(rules, log) {
  if (!commandExists('iptables')) return false;
  let ok = true;
  for (const r of rules) {
    const protoUpper = r.proto.toUpperCase();
    const match = r.portStart != null
      ? `-m multiport --dports ${r.portStart}:${r.portEnd}`
      : `--dport ${r.port}`;
    try {
      // Проверяем, нет ли уже такого правила, прежде чем добавлять — чтобы
      // при перезапуске сервера не плодить дубликаты на каждый старт.
      const checkCmd = `iptables -C INPUT -p ${r.proto} ${match} -j ACCEPT`;
      try { run(checkCmd); continue; } catch (e) { /* правила ещё нет — добавляем ниже */ }
      run(`iptables -I INPUT -p ${r.proto} ${match} -j ACCEPT`);
      log(`iptables: разрешён порт ${portSpec(r)}/${r.proto} (учтите: без iptables-persistent это правило не переживёт перезагрузку сервера)`);
    } catch (e) {
      ok = false;
      log(`iptables: не удалось разрешить порт ${portSpec(r)}/${r.proto} (${e.message.split('\n')[0]})`);
    }
  }
  return ok;
}

// Возвращает { attempted: bool, tool: string|null } — attempted=false значит
// "ничего не трогали" (нет прав или ни один инструмент не найден), и тогда
// вызывающий код должен явно предупредить человека, что порты нужно
// проверить самому (панель хостинга/роутер).
function autoOpenPorts(rules, log = () => {}) {
  if (!isRoot()) {
    log('Нет прав root — пропускаем автоматическую настройку файрвола ОС.');
    return { attempted: false, tool: null };
  }
  try {
    if (tryUfw(rules, log)) return { attempted: true, tool: 'ufw' };
    if (tryFirewalld(rules, log)) return { attempted: true, tool: 'firewalld' };
    if (tryIptables(rules, log)) return { attempted: true, tool: 'iptables' };
  } catch (e) {
    log('Ошибка при автоматической настройке файрвола: ' + e.message);
  }
  log('Не найден ни ufw, ни firewalld, ни iptables — файрвол ОС не трогали (возможно, его тут и нет).');
  return { attempted: false, tool: null };
}

module.exports = { autoOpenPorts };
