import { firebaseConfig, ADMIN_CODE, STAFF_CODE } from './firebase-config.js';
import { SEED_CASES, SEED_COURT_CASES, SEED_LOG } from './seed-data.js';
import { COURT_UPDATE_ENDPOINT } from './court-update-config.js';

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getFirestore, collection, doc, getDoc, getDocs, addDoc, updateDoc, setDoc,
  onSnapshot, writeBatch, runTransaction
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

/* ---------------------------------------------------------------------------
   FIREBASE (объявления — до блока ДОСТУП, т.к. boot() может вызваться сразу)
--------------------------------------------------------------------------- */
let db;
let CASES = [];       // локальный кэш дел (живёт из onSnapshot)
let COURT = [];
let LOGS = [];
let BACKUPS = [];
let modalHearings = [];   // временный список заседаний, пока открыта карточка судопроизводства
let importDiffs = [];     // изменения, посчитанные при предпросмотре импорта
let courtUpdateDiffs = []; // изменения заседаний, полученные от сайта суда до подтверждения
let bootStarted = false;
let lastFocusedElement = null;
const listenerReady = { cases:false, court:false, logs:false };
const LOG_RETENTION_LIMIT = 100;
const MANUAL_BACKUP_RETENTION_LIMIT = 10;
let logPruneInFlight = false;
let backupPruneInFlight = false;
const pendingLogPruneIds = new Set();
const pendingBackupPruneIds = new Set();

/* ---------------------------------------------------------------------------
   ФИКСИРОВАННЫЕ СТАТУСЫ (значок и группа подставляются автоматически)
--------------------------------------------------------------------------- */
const STATUS_DEFS = {
  sent_court:   { label:'Направлено в суд',                         icon:'✅', badge:'done',     group:'A' },
  sent_debtor:  { label:'Направлено ответчику, ждём реестр',        icon:'📮', badge:'progress', group:'A' },
  signing:      { label:'Иск на подписи',                            icon:'✍️', badge:'progress', group:'A' },
  draft:        { label:'Черновик готовится',                       icon:'🟡', badge:'wait',     group:'B' },
  waiting_doc:  { label:'Ожидаем документы',              icon:'⏸', badge:'wait',     group:'B' },
  problem:      { label:'Проблема — требует решения',               icon:'🔴', badge:'problem',  group:'B' },
  postponed:    { label:'Отложено — долг ещё не просужен',          icon:'⏳', badge:'wait',     group:'V' },
  disconnected: { label:'Отключено',                                icon:'⚪', badge:'none',     group:'G' },
  paid:         { label:'Оплачено',                                 icon:'⚪', badge:'none',     group:'G' },
};
const STATUS_ORDER = Object.keys(STATUS_DEFS);
const GROUP_ORDER = ['A','B','V','G'];
const GROUP_TITLES = {
  A:'Группа А. Готово / направлено',
  B:'Группа Б. На подготовке',
  V:'Группа В. Отложено',
  G:'Группа Г. Не требуется'
};

/* ---------------------------------------------------------------------------
   ДОСТУП (роли: admin / staff — простой код, не полноценная авторизация)
--------------------------------------------------------------------------- */
const gate = document.getElementById('gate');
const app = document.getElementById('app');
const gateInput = document.getElementById('gate-input');
const gateError = document.getElementById('gate-error');

function applyRole(role){
  document.body.classList.toggle('role-admin', role === 'admin');
}

function tryUnlock(){
  let role = null;
  if(gateInput.value === ADMIN_CODE) role = 'admin';
  else if(gateInput.value === STAFF_CODE) role = 'staff';

  if(role){
    sessionStorage.setItem('gmi-unlocked', '1');
    sessionStorage.setItem('gmi-role', role);
    applyRole(role);
    gate.hidden = true;
    app.hidden = false;
    boot();
  } else {
    gateError.hidden = false;
  }
}
document.getElementById('gate-submit').addEventListener('click', tryUnlock);
gateInput.addEventListener('keydown', e => { if(e.key === 'Enter') tryUnlock(); });

if(sessionStorage.getItem('gmi-unlocked') === '1'){
  applyRole(sessionStorage.getItem('gmi-role') || 'staff');
  gate.hidden = true;
  app.hidden = false;
  boot();
}

async function boot(){
  if(bootStarted) return;
  bootStarted = true;

  if(firebaseConfig.apiKey === 'ВСТАВЬТЕ_СЮДА'){
    document.getElementById('groups').innerHTML =
      `<div style="padding:40px;text-align:center;color:var(--stamp-red)">
         Firebase не настроен. Откройте <code>firebase-config.js</code> и вставьте
         данные вашего проекта — инструкция в README.md.
       </div>`;
    setConnectionStatus('offline', '● Firebase не настроен');
    return;
  }

  setConnectionStatus('connecting', '● подключение…');
  try{
    const fbApp = initializeApp(firebaseConfig);
    db = getFirestore(fbApp);

    await seedIfEmpty();
    await migrateLegacyCases();
    await migrateLegacyCourt();
    await fixLegacyNotesOnce();
    await migrateStatusConsistencyV1();
    await ensureBaselineBackup();

    listenCases();
    listenCourt();
    listenLogs();
    listenBackups();
  }catch(err){
    setConnectionStatus('offline', '● ошибка подключения');
    reportError('Не удалось запустить приложение', err);
  }
}

async function seedIfEmpty(){
  const snap = await getDocs(collection(db, 'cases'));
  if(!snap.empty) return;

  const batch = writeBatch(db);
  SEED_CASES.forEach(c => {
    const ref = doc(collection(db, 'cases'));
    batch.set(ref, c);
  });
  SEED_COURT_CASES.forEach(c => {
    const ref = doc(collection(db, 'courtCases'));
    batch.set(ref, c);
  });
  SEED_LOG.forEach(l => {
    const ref = doc(collection(db, 'logs'));
    batch.set(ref, l);
  });
  await batch.commit();
}

// Разовая миграция дел, заведённых по старой схеме (icon/badge/fee текстом),
// на новую схему с фиксированными statusKey/feeKey. Срабатывает один раз —
// у уже мигрированных документов есть поле statusKey, их пропускаем.
async function migrateLegacyCases(){
  const snap = await getDocs(collection(db, 'cases'));
  const jobs = [];
  snap.docs.forEach(d => {
    const c = d.data();
    if(c.statusKey) return;
    let statusKey = 'draft';
    if(c.icon === '✅') statusKey = 'sent_court';
    else if(c.icon === '📮') statusKey = 'sent_debtor';
    else if(c.icon === '🟡') statusKey = 'draft';
    else if(c.icon === '⏸') statusKey = 'waiting_doc';
    else if(c.icon === '🔴') statusKey = 'problem';
    else if(c.icon === '🚫') statusKey = 'postponed';
    else if(c.icon === '⚪') statusKey = /оплач/i.test(c.status || '') ? 'paid' : 'disconnected';
    const feeKey = /оплачен/i.test(c.fee || '') ? 'paid' : 'unpaid';
    jobs.push(updateDoc(doc(db, 'cases', d.id), {
      statusKey, note: c.status || '', feeKey, address: c.address || '', protected: true
    }));
  });
  if(jobs.length) await Promise.all(jobs);
}

// Разовая миграция судебных карточек: одна дата заседания + зал -> массив
// заседаний + судья (данные о зале сохраняются в заметках, чтобы не потерять).
async function migrateLegacyCourt(){
  const snap = await getDocs(collection(db, 'courtCases'));
  const jobs = [];
  snap.docs.forEach(d => {
    const c = d.data();
    if(c.hearings) return;
    const hearings = c.hearingDate ? [{ date: c.hearingDate, note: '' }] : [];
    const extra = c.hearingRoom ? ` (Зал: ${c.hearingRoom})` : '';
    jobs.push(updateDoc(doc(db, 'courtCases', d.id), {
      hearings, judge: c.judge || '', notes: (c.notes || '') + extra
    }));
  });
  if(jobs.length) await Promise.all(jobs);
}

// Разовая правка: у части дел после первой миграции в "примечание" попал
// полный старый текст статуса, который задваивался с новым фиксированным
// названием статуса (наложение текста в интерфейсе). Также здесь же —
// точечное обновление карточки Шуркиной по индексу от 20.07.2026.
// Срабатывает один раз на документ (флаг notesFixed), дальше не трогает.
const NOTE_FIXES = {
  '100021470': { note:'Заседание 30.07.2026, 10:00' },
  '100004288': { note:'Реестр получен, ждём оригинал выписки с л/с' },
  '090011317': { note:'15.07.2026' },
  '090007807': { note:'15.07.2026' },
  '090024016': { note:'15.07.2026' },
  '050002779': { note:'' },
  '100011188': { note:'16.07.2026' },
  '110062695': { note:'17.07.2026, ждём реестр' },
  '010504941': { note:'Ждём точный период начисления долга (151 463,54 руб.)' },
  '130000154': { statusKey:'signing', note:'Иск на подписи (20.07.2026)' },
  '080020736': { note:'Задолженность не просужена' },
  '010016290': { note:'' },
  '010015694': { note:'' },
  '100007765': { note:'' },
  '020005837': { note:'' },
  '100005712': { note:'01.07.2026' },
  '130000135': { note:'08.07.2026' },
  '130001042': { note:'08.07.2026' },
};
async function fixLegacyNotesOnce(){
  const snap = await getDocs(collection(db, 'cases'));
  const jobs = [];
  let shurkinaFixed = false;
  snap.docs.forEach(d => {
    const c = d.data();
    if(c.notesFixed) return;
    const fix = NOTE_FIXES[c.account];
    const patch = { notesFixed: true };
    if(fix){
      if(fix.note !== undefined) patch.note = fix.note;
      if(fix.statusKey) patch.statusKey = fix.statusKey;
      if(c.account === '130000154' && fix.statusKey) shurkinaFixed = true;
    }
    jobs.push(updateDoc(doc(db, 'cases', d.id), patch));
  });
  if(jobs.length) await Promise.all(jobs);
  if(shurkinaFixed) await addLog('Шуркина: статус обновлён — иск на подписи (по данным индекса от 20.07.2026).');
}

// Разовая проверка смысловой согласованности статусов.
// Исправляет старую ошибку, когда Шуркина с примечанием «Иск на подписи»
// была ошибочно отнесена к уже направленным в суд. Флаг хранится отдельно
// в meta/migrations, поэтому пользовательские изменения после миграции
// повторно не перезаписываются.
async function migrateStatusConsistencyV1(){
  const migrationRef = doc(db, 'meta', 'migrations');
  const migrationSnap = await getDoc(migrationRef);
  if(migrationSnap.exists() && migrationSnap.data().statusConsistencyV1) return;

  const snap = await getDocs(collection(db, 'cases'));
  const shurkinaDoc = snap.docs.find(d => d.data().account === '130000154');
  const batch = writeBatch(db);
  const items = [];

  if(shurkinaDoc){
    const before = shurkinaDoc.data();
    const noteSaysSigning = /(?:иск\s+)?на\s+подпис/i.test(before.note || '');
    if(before.statusKey === 'sent_court' && noteSaysSigning){
      const after = { ...before, statusKey:'signing' };
      batch.update(doc(db, 'cases', shurkinaDoc.id), { statusKey:'signing' });
      items.push({
        collection:'cases', docId:shurkinaDoc.id,
        label:`Шуркина Лидия Леонидовна · л/с ${before.account}`,
        before:recordData({ id:shurkinaDoc.id, ...before }),
        after:recordData({ id:shurkinaDoc.id, ...after })
      });
    }
  }

  batch.set(migrationRef, { statusConsistencyV1:true, statusConsistencyV1At:Date.now() }, { merge:true });
  if(items.length){
    batch.set(doc(collection(db, 'logs')), operationLogPayload({
      text:'Исправлена классификация статуса Шуркиной: «Направлено в суд» → «Иск на подписи».',
      action:'system.migration', items, meta:{ migration:'statusConsistencyV1' }
    }));
  }
  await batch.commit();
}

function listenCases(){
  onSnapshot(collection(db, 'cases'), snap => {
    CASES = snap.docs.map(d => ({ id:d.id, ...d.data() }));
    renderGroups();
    renderSummary();
    const stampTotal = document.getElementById('stamp-total');
    if(stampTotal) stampTotal.textContent = CASES.length || 18;
    markListenerReady('cases');
  }, err => handleListenerError('реестра дел', err));
}
function listenCourt(){
  onSnapshot(collection(db, 'courtCases'), snap => {
    COURT = snap.docs.map(d => ({ id:d.id, ...d.data() }));
    renderGroups();
    renderCourt();
    renderCourtSummary();
    renderSummary();
    markListenerReady('court');
  }, err => handleListenerError('судебного производства', err));
}
function listenLogs(){
  onSnapshot(collection(db, 'logs'), snap => {
    const sortedLogs = snap.docs.map(d => ({ id:d.id, ...d.data() }))
      .sort((a,b) => (b.date||'').localeCompare(a.date||'') || (Number(b.createdAt)||0) - (Number(a.createdAt)||0));
    const overflow = sortedLogs.slice(LOG_RETENTION_LIMIT);
    LOGS = sortedLogs.slice(0, LOG_RETENTION_LIMIT);
    renderLog();
    const updatedEl = document.getElementById('last-updated');
    if(LOGS[0]){
      const last = LOGS[0];
      const time = last.createdAt ? `, ${formatShortTimeFromMs(last.createdAt)}` : '';
      updatedEl.textContent = `обновлено ${formatRuDate(last.date)}${time}`;
    } else {
      updatedEl.textContent = 'обновлено —';
    }
    if(overflow.length) void pruneLogOverflow(overflow);
    markListenerReady('logs');
  }, err => handleListenerError('журнала изменений', err));
}

function markListenerReady(name){
  listenerReady[name] = true;
  if(navigator.onLine && Object.values(listenerReady).every(Boolean)){
    setConnectionStatus('online', '● подключено');
  }
}

function handleListenerError(section, err){
  setConnectionStatus('offline', '● офлайн / ошибка подключения');
  reportError(`Ошибка загрузки ${section}`, err, false);
}

function currentRole(){
  return sessionStorage.getItem('gmi-role') || 'staff';
}

function actorLabel(role=currentRole()){
  return role === 'admin' ? 'Администратор' : 'Сотрудник';
}

function recordData(record){
  if(!record) return null;
  const { id, ...data } = record;
  return JSON.parse(JSON.stringify(data));
}

async function deleteDocumentsInChunks(collectionName, ids){
  const uniqueIds = [...new Set((ids || []).filter(Boolean))];
  for(let offset = 0; offset < uniqueIds.length; offset += 450){
    const batch = writeBatch(db);
    uniqueIds.slice(offset, offset + 450).forEach(id => batch.delete(doc(db, collectionName, id)));
    await batch.commit();
  }
}

async function pruneLogOverflow(entries){
  entries.forEach(entry => { if(entry?.id) pendingLogPruneIds.add(entry.id); });
  if(logPruneInFlight || !pendingLogPruneIds.size) return;
  logPruneInFlight = true;
  try{
    while(pendingLogPruneIds.size){
      const ids = [...pendingLogPruneIds];
      pendingLogPruneIds.clear();
      await deleteDocumentsInChunks('logs', ids);
    }
  }catch(err){
    reportError('Не удалось удалить старые записи журнала', err, false);
  }finally{
    logPruneInFlight = false;
    if(pendingLogPruneIds.size) void pruneLogOverflow([]);
  }
}

async function pruneManualBackupOverflow(entries){
  entries.forEach(entry => { if(entry?.id) pendingBackupPruneIds.add(entry.id); });
  if(backupPruneInFlight || !pendingBackupPruneIds.size) return;
  backupPruneInFlight = true;
  try{
    while(pendingBackupPruneIds.size){
      const ids = [...pendingBackupPruneIds];
      pendingBackupPruneIds.clear();
      await deleteDocumentsInChunks('backups', ids);
    }
  }catch(err){
    reportError('Не удалось удалить старые ручные резервные копии', err, false);
  }finally{
    backupPruneInFlight = false;
    if(pendingBackupPruneIds.size) void pruneManualBackupOverflow([]);
  }
}

function logPayload(text, extra={}){
  return {
    date: todayLocalIso(),
    createdAt: Date.now(),
    text,
    actorRole: currentRole(),
    actorLabel: actorLabel(),
    action: 'note',
    reversible: false,
    ...extra
  };
}

function operationLogPayload({ text, action, items, sourceLogId='', meta={} }){
  return logPayload(text, {
    action,
    items: JSON.parse(JSON.stringify(items || [])),
    reversible: true,
    undoneAt: null,
    sourceLogId,
    meta
  });
}

async function addLog(text){
  await addDoc(collection(db, 'logs'), logPayload(text));
}

async function commitOperation(mutator, { text, action, items, meta={} }){
  const batch = writeBatch(db);
  mutator(batch);
  batch.set(doc(collection(db, 'logs')), operationLogPayload({ text, action, items, meta }));
  await batch.commit();
}

async function readWorkingSnapshot(){
  const [casesSnap, courtSnap, counterSnap] = await Promise.all([
    getDocs(collection(db, 'cases')),
    getDocs(collection(db, 'courtCases')),
    getDoc(doc(db, 'meta', 'counters'))
  ]);
  return {
    cases: casesSnap.docs.map(d => ({ id:d.id, data:d.data() })),
    courtCases: courtSnap.docs.map(d => ({ id:d.id, data:d.data() })),
    counters: counterSnap.exists() ? counterSnap.data() : null
  };
}

async function ensureBaselineBackup(){
  const baselineRef = doc(db, 'backups', 'baseline-v2');
  const existing = await getDoc(baselineRef);
  if(existing.exists()) return;
  const snapshot = await readWorkingSnapshot();
  await setDoc(baselineRef, {
    name: 'Базовый снимок перед внедрением отмены изменений',
    type: 'baseline',
    date: todayLocalIso(),
    createdAt: Date.now(),
    actorRole: currentRole(),
    actorLabel: actorLabel(),
    version: 2,
    ...snapshot
  });
}

function listenBackups(){
  onSnapshot(collection(db, 'backups'), snap => {
    const sortedBackups = snap.docs.map(d => ({ id:d.id, ...d.data() }))
      .sort((a,b) => (Number(b.createdAt)||0) - (Number(a.createdAt)||0));
    const manualBackups = sortedBackups.filter(b => b.type === 'manual');
    const overflow = manualBackups.slice(MANUAL_BACKUP_RETENTION_LIMIT);
    const overflowIds = new Set(overflow.map(b => b.id));
    BACKUPS = sortedBackups.filter(b => !overflowIds.has(b.id));
    renderBackups();
    if(overflow.length) void pruneManualBackupOverflow(overflow);
  }, err => reportError('Ошибка загрузки резервных копий', err, false));
}

/* ---------------------------------------------------------------------------
   РЕНДЕР: РЕЕСТР ДЕЛ
--------------------------------------------------------------------------- */
function renderGroups(){
  const el = document.getElementById('groups');
  el.innerHTML = '';
  GROUP_ORDER.forEach(gid => {
    const cases = CASES.filter(c => (STATUS_DEFS[c.statusKey]||{}).group === gid).sort((a,b) => a.num - b.num);
    if(cases.length === 0) return;
    const group = document.createElement('div');
    group.className = 'group';
    group.innerHTML = `
      <div class="group-head">
        <h2>${GROUP_TITLES[gid]}</h2>
        <span class="group-count">${cases.length} ${pluralDela(cases.length)}</span>
      </div>
    `;
    cases.forEach(c => {
      const def = STATUS_DEFS[c.statusKey] || STATUS_DEFS.draft;
      const courtCase = linkedCourtCase(c);
      const completedCourt = courtCase && isCompletedCourtCase(courtCase) ? courtCase : null;
      const decisionDate = completedCourt ? courtDecisionDateOf(completedCourt) : '';
      const displayedStatus = completedCourt
        ? {
            icon:DOT[completedCourt.dot],
            label:courtOutcomeLabel(completedCourt),
            badge:completedCourt.dot === 'done' ? 'done' : (completedCourt.dot === 'denied' ? 'problem' : 'wait')
          }
        : def;
      const row = document.createElement('div');
      row.className = `case-row${completedCourt ? ' case-row-completed' : ''}`;
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', `Открыть карточку: ${c.name}`);
      row.innerHTML = `
        <div class="case-num">${String(c.num).padStart(2,'0')}</div>
        <div>
          <div class="case-name">${escapeHtml(c.name)}</div>
          <div class="case-account">л/с ${escapeHtml(c.account || '—')}</div>
        </div>
        <div class="case-status">
          <span class="badge badge-${displayedStatus.badge}">${displayedStatus.icon} ${escapeHtml(displayedStatus.label)}</span>
          ${completedCourt ? `<div class="case-note">Решение${decisionDate ? ' от '+formatRuDate(decisionDate) : ': дата не указана'}</div>` : ''}
          ${c.note ? `<div class="case-note">${escapeHtml(c.note)}</div>` : ''}
        </div>
        <div class="case-fee${completedCourt ? ' case-finished-label' : ''}">${completedCourt ? '⚖️ завершено' : `💳 ${c.feeKey === 'paid' ? 'оплачена' : 'не оплачена'}`}</div>
        <div class="case-edit-icon">✎</div>
        ${completedCourt ? completedCourtDetailsHtml(completedCourt) : ''}
      `;
      row.querySelectorAll('[data-court-site-link]').forEach(link => {
        link.addEventListener('click', event => event.stopPropagation());
        link.addEventListener('keydown', event => event.stopPropagation());
      });
      row.addEventListener('click', () => openCaseModal(c));
      row.addEventListener('keydown', e => {
        if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); openCaseModal(c); }
      });
      group.appendChild(row);
    });
    el.appendChild(group);
  });
}

const SUMMARY_CHIP_DEFS = [
  { key:'sent_court',  label:'Готово/направлено' },
  { key:'sent_debtor', label:'Отправка' },
  { key:'signing',     label:'На подписи' },
  { key:'draft',       label:'Черновик' },
  { key:'waiting_doc', label:'Ожидание' },
  { key:'problem',     label:'Проблема' },
  { key:'postponed',   label:'Отложено' },
];

function renderSummary(){
  const strip = document.getElementById('summary-strip');
  const counts = {};
  CASES.forEach(c => { counts[c.statusKey] = (counts[c.statusKey]||0) + 1; });
  const notNeeded = (counts.disconnected||0) + (counts.paid||0);

  let html = `<div class="summary-chip chip-link" onclick="window.switchTabByName('court')">⚖️ В суде: <b>${COURT.length}</b></div>`;
  html += SUMMARY_CHIP_DEFS.map(cd => counts[cd.key]
    ? `<div class="summary-chip">${STATUS_DEFS[cd.key].icon} ${cd.label}: <b>${counts[cd.key]}</b></div>`
    : ''
  ).join('');
  if(notNeeded) html += `<div class="summary-chip">⚪ Не требуется: <b>${notNeeded}</b></div>`;
  html += `<div class="summary-chip">Всего дел: <b>${CASES.length}</b></div>`;
  strip.innerHTML = html;
}

function pluralDela(n){
  const mod10 = n % 10, mod100 = n % 100;
  if(mod10===1 && mod100!==11) return 'дело';
  if([2,3,4].includes(mod10) && ![12,13,14].includes(mod100)) return 'дела';
  return 'дел';
}

/* ---------------------------------------------------------------------------
   РЕНДЕР: СУДЕБНОЕ ПРОИЗВОДСТВО
--------------------------------------------------------------------------- */
const DOT = { blue:'🔵', done:'✅', denied:'❌', partial:'🟠' };
const COURT_OUTCOME_LABELS = {
  done:'Удовлетворено',
  denied:'Отказано',
  partial:'Удовлетворено частично'
};

function isCompletedCourtCase(c){
  return !!COURT_OUTCOME_LABELS[c?.dot];
}

function courtOutcomeLabel(c){
  return COURT_OUTCOME_LABELS[c?.dot] || 'В процессе';
}

function hearingDateObject(value){
  if(!value) return null;
  // Старые записи могли содержать только дату без времени. Такое заседание
  // считаем актуальным до конца указанного дня, а не только до 00:00.
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59` : value;
  const dt = new Date(normalized);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function hearingsOf(c){
  return Array.isArray(c?.hearings) ? c.hearings : [];
}

function latestHearingOf(c){
  return hearingsOf(c)
    .map(h => ({ hearing:h, dt:hearingDateObject(h?.date) }))
    .filter(x => x.dt)
    .sort((a,b) => b.dt - a.dt)[0]?.hearing || null;
}

function courtDecisionDateOf(c){
  const latest = latestHearingOf(c);
  return latest?.date ? latest.date.split('T')[0] : '';
}

function nearestUpcomingHearingOf(c){
  if(isCompletedCourtCase(c)) return null;
  const now = new Date();
  return hearingsOf(c)
    .map(h => ({ hearing:h, dt:hearingDateObject(h?.date) }))
    .filter(x => x.dt && x.dt >= now)
    .sort((a,b) => a.dt - b.dt)[0]?.hearing || null;
}

// Дело требует внимания, если последнее назначенное заседание уже прошло,
// а следующей даты в карточке ещё нет.
function latestPassedHearingAwaitingUpdateOf(c){
  if(isCompletedCourtCase(c) || nearestUpcomingHearingOf(c)) return null;
  const now = new Date();
  return hearingsOf(c)
    .map(h => ({ hearing:h, dt:hearingDateObject(h?.date) }))
    .filter(x => x.dt && x.dt < now)
    .sort((a,b) => b.dt - a.dt)[0]?.hearing || null;
}

function courtCasesAwaitingHearingDate(){
  return COURT
    .filter(c => !isCompletedCourtCase(c))
    .map(c => ({ caseData:c, hearing:latestPassedHearingAwaitingUpdateOf(c) }))
    .filter(item => item.hearing);
}

function compareCourtCases(a,b){
  const aCompleted = isCompletedCourtCase(a);
  const bCompleted = isCompletedCourtCase(b);
  if(aCompleted !== bCompleted) return aCompleted ? 1 : -1;

  if(!aCompleted){
    const aNext = nearestUpcomingHearingOf(a);
    const bNext = nearestUpcomingHearingOf(b);
    const aTime = hearingDateObject(aNext?.date)?.getTime() ?? Number.POSITIVE_INFINITY;
    const bTime = hearingDateObject(bNext?.date)?.getTime() ?? Number.POSITIVE_INFINITY;
    if(aTime !== bTime) return aTime - bTime;
    const aAwaiting = !!latestPassedHearingAwaitingUpdateOf(a);
    const bAwaiting = !!latestPassedHearingAwaitingUpdateOf(b);
    if(aAwaiting !== bAwaiting) return aAwaiting ? -1 : 1;
  }else{
    const aTime = hearingDateObject(latestHearingOf(a)?.date)?.getTime() ?? Number.NEGATIVE_INFINITY;
    const bTime = hearingDateObject(latestHearingOf(b)?.date)?.getTime() ?? Number.NEGATIVE_INFINITY;
    if(aTime !== bTime) return bTime - aTime;
  }

  return courtSortNumber(a) - courtSortNumber(b)
    || (a.name || '').localeCompare(b.name || '', 'ru');
}

function completedCourtDetailsHtml(c){
  const decisionDate = courtDecisionDateOf(c);
  const hearings = hearingsOf(c)
    .slice()
    .sort((a,b) => (hearingDateObject(a?.date)?.getTime() || 0) - (hearingDateObject(b?.date)?.getTime() || 0));
  const meta = [
    c.court,
    c.caseNumber ? `дело №${c.caseNumber}` : '',
    c.judge ? `судья ${c.judge}` : ''
  ].filter(Boolean).map(escapeHtml).join(' · ');
  const hearingItems = hearings.length
    ? hearings.map(h => `<li><b>${formatRuDateTime(h.date)}</b>${h.note ? ` — ${escapeHtml(h.note)}` : ''}</li>`).join('')
    : '<li>Сведения о заседаниях не указаны.</li>';

  return `<div class="case-court-details">
    <div class="case-court-result"><b>${DOT[c.dot]} ${escapeHtml(courtOutcomeLabel(c))}</b> · решение${decisionDate ? ' от '+formatRuDate(decisionDate) : ': дата не указана'}</div>
    ${meta ? `<div class="case-court-meta">${meta}</div>` : ''}
    <div class="case-court-section"><b>Проведённые заседания:</b><ul>${hearingItems}</ul></div>
    ${c.notes ? `<div class="case-court-section"><b>Материалы и примечания:</b> ${escapeHtml(c.notes)}</div>` : ''}
    ${courtSiteLinkHtml(c)}
  </div>`;
}

function courtSiteLinkHtml(c, compact=false){
  const href = normalizeWebUrl(c?.caseUrl);
  if(!href) return '';
  return `<a class="court-site-link${compact ? ' court-site-link-compact' : ''}" data-court-site-link href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${compact ? 'Сайт суда ↗' : 'Перейти на сайт суда ↗'}</a>`;
}

const COURT_EQUIPMENT_BY_ACCOUNT = {
  '100021470': [
    { type:'stove', label:'Плита', quantity:1 },
    { type:'boiler', label:'Котёл / теплогенератор', quantity:1 }
  ],
  '100004288': [
    { type:'stove', label:'Плита', quantity:1 },
    { type:'boiler', label:'Котёл / теплогенератор', quantity:1 },
    { type:'waterHeater', label:'Колонка', quantity:1 },
    { type:'meter', label:'Счётчик', quantity:1 }
  ],
  '090011317': [
    { type:'stove', label:'Плита', quantity:1 },
    { type:'waterHeater', label:'Колонка', quantity:1 }
  ],
  '090007807': [
    { type:'stove', label:'Плита', quantity:1 },
    { type:'waterHeater', label:'Колонка', quantity:1 }
  ],
  '090024016': [
    { type:'stove', label:'Плита', quantity:1 },
    { type:'waterHeater', label:'Колонка', quantity:1 }
  ],
  '050002779': [
    { type:'boiler', label:'Котёл / теплогенератор', quantity:1 }
  ],
  '100011188': [
    { type:'stove', label:'Плита', quantity:1 },
    { type:'boiler', label:'Котёл / теплогенератор', quantity:1 },
    { type:'meter', label:'Счётчик', quantity:1 }
  ],
  '110062695': [
    { type:'stove', label:'Плита', quantity:1 },
    { type:'boiler', label:'Котёл / теплогенератор', quantity:1 },
    { type:'meter', label:'Счётчик', quantity:1 }
  ],
  '010504941': [
    { type:'stove', label:'Плита', quantity:1 },
    { type:'boiler', label:'Котёл / теплогенератор', quantity:2 },
    { type:'meter', label:'Счётчик', quantity:2 }
  ],
  '130000154': [
    { type:'stove', label:'Плита', quantity:1 },
    { type:'waterHeater', label:'Колонка', quantity:1 }
  ]
};

function courtEquipmentOf(c){
  if(Array.isArray(c?.equipment) && c.equipment.length) return c.equipment;
  return COURT_EQUIPMENT_BY_ACCOUNT[String(c?.account || '').trim()] || [];
}

function equipmentIconSvg(type){
  const common = 'viewBox="0 0 24 24" aria-hidden="true" focusable="false"';
  if(type === 'stove') return `<svg ${common}><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="2.2"/><circle cx="16" cy="9" r="2.2"/><circle cx="8" cy="15" r="2.2"/><circle cx="16" cy="15" r="2.2"/></svg>`;
  if(type === 'waterHeater') return `<svg ${common}><rect x="5" y="2.5" width="14" height="19" rx="2"/><path d="M9 6h6M12 18c-2.1 0-3.4-1.5-3.4-3.1 0-1.7 1.5-3.1 3.4-5.4 1.9 2.3 3.4 3.7 3.4 5.4 0 1.6-1.3 3.1-3.4 3.1Z"/><path d="M12 13.2c.8 1 .9 1.4.9 1.8 0 .5-.4.9-.9.9s-.9-.4-.9-.9c0-.4.1-.8.9-1.8Z"/></svg>`;
  if(type === 'boiler') return `<svg ${common}><path d="M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M8 7h8M12 17.8c-1.8 0-3-1.2-3-2.7 0-1.4 1.2-2.6 3-4.8 1.8 2.2 3 3.4 3 4.8 0 1.5-1.2 2.7-3 2.7Z"/><path d="M21.5 8c1-1 1-2 0-3M21.5 14c1-1 1-2 0-3"/></svg>`;
  return `<svg ${common}><circle cx="12" cy="12" r="8.5"/><path d="M7.5 10a5 5 0 0 1 9 0M12 12l3-3"/><circle cx="12" cy="12" r="1"/><path d="M8 16.5h8"/></svg>`;
}

function courtEquipmentHtml(c){
  const equipment = courtEquipmentOf(c);
  if(!equipment.length) return '';
  const items = equipment.map(item => {
    const quantity = Math.max(1, Number(item.quantity) || 1);
    const label = String(item.label || 'Оборудование').trim();
    return `<span class="equipment-chip equipment-${escapeAttr(item.type || 'meter')}" aria-label="${escapeAttr(label)}, количество ${quantity}">
      <span class="equipment-icon">${equipmentIconSvg(item.type)}</span>
      <span class="equipment-name">${escapeHtml(label)}</span>
      <b class="equipment-quantity">×${quantity}</b>
    </span>`;
  }).join('');
  return `<div class="court-equipment" aria-label="Газовое оборудование">
    <div class="court-equipment-title">Оборудование</div>
    <div class="court-equipment-list">${items}</div>
  </div>`;
}

function upcomingCourtHearings(){
  return COURT
    .map(c => {
      const hearing = nearestUpcomingHearingOf(c);
      return hearing ? { caseData:c, hearing, dt:hearingDateObject(hearing.date) } : null;
    })
    .filter(x => x && x.dt)
    .sort((a,b) => a.dt - b.dt || (a.caseData.name||'').localeCompare(b.caseData.name||'', 'ru'));
}

let courtInfoHighlightTimer = null;

function renderCourt(){
  const el = document.getElementById('court-list');
  renderCourtHearingWarning();
  if(COURT.length === 0){
    el.innerHTML = `<p style="color:var(--ink-soft)">Пока нет дел в судебном производстве — появятся здесь, как только иск будет направлен в суд.</p>`;
    return;
  }
  el.innerHTML = '';
  COURT.slice().sort(compareCourtCases).forEach(c => {
    const card = document.createElement('div');
    const completed = isCompletedCourtCase(c);
    const awaitingDate = !completed ? latestPassedHearingAwaitingUpdateOf(c) : null;
    card.className = `court-card${completed ? ' court-card-completed' : ''}${awaitingDate ? ' court-card-awaiting-date' : ''}`;
    card.dataset.courtInfoId = c.id;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Открыть судебное дело: ${c.name}`);
    const nh = nearestUpcomingHearingOf(c);
    const decisionDate = completed ? courtDecisionDateOf(c) : '';
    const hearingText = completed
      ? `${courtOutcomeLabel(c)} · решение${decisionDate ? ' от '+formatRuDate(decisionDate) : ': дата не указана'}`
      : (nh ? formatRuDateTime(nh.date) : (awaitingDate ? `заседание прошло ${formatRuDateTime(awaitingDate.date)}` : 'не назначено'));
    const preparation = nh && nh.note ? nh.note.trim() : '';
    card.innerHTML = `
      <div class="court-dot">${DOT[c.dot]||'🔵'}</div>
      <div>
        <div class="court-name">${escapeHtml(c.name)}</div>
        <div class="court-meta">${escapeHtml(c.court || '—')}${c.caseNumber ? ' · дело №'+escapeHtml(c.caseNumber) : ''}${c.filedDate ? ' · подан '+formatRuDate(c.filedDate) : ''}</div>
        ${courtEquipmentHtml(c)}
        ${c.notes ? `<div class="court-card-note"><b>Примечание:</b> ${escapeHtml(c.notes)}</div>` : '<div class="court-card-note is-empty"><b>Примечание:</b> не указано</div>'}
        ${courtSiteLinkHtml(c)}
      </div>
      <div class="court-hearing">
        <b>${hearingText}</b>
        ${awaitingDate ? '<div class="court-hearing-awaiting">Новая дата не назначена — проверьте сведения на сайте суда.</div>' : ''}
        ${nh ? `<div class="court-preparation"><span>Подготовить:</span> ${escapeHtml(preparation || 'не указано')}</div>` : ''}
        ${c.judge ? `<div class="court-judge">Судья: ${escapeHtml(c.judge)}</div>` : ''}
      </div>
    `;
    card.querySelectorAll('[data-court-site-link]').forEach(link => {
      link.addEventListener('click', event => event.stopPropagation());
      link.addEventListener('keydown', event => event.stopPropagation());
    });
    card.addEventListener('click', () => openCourtModal(c));
    card.addEventListener('keydown', e => {
      if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); openCourtModal(c); }
    });
    el.appendChild(card);
  });
}

function renderCourtSummary(){
  const el = document.getElementById('court-summary-strip');
  if(!el) return;
  const now = new Date();
  const upcoming = upcomingCourtHearings();
  const weekAhead = new Date(now.getTime() + 7*24*3600*1000);
  let weekCount = 0;
  COURT.filter(c => !isCompletedCourtCase(c)).forEach(c => hearingsOf(c).forEach(h => {
    const dt = hearingDateObject(h?.date);
    if(dt && dt >= now && dt <= weekAhead) weekCount++;
  }));

  const upcomingHtml = upcoming.length
    ? `<section class="upcoming-summary" aria-label="Ближайшие заседания">
        <div class="upcoming-summary-head">
          <b>⏰ Ближайшие заседания</b>
          <span>все назначенные</span>
        </div>
        <div class="upcoming-summary-list">
          ${upcoming.map(({caseData, hearing}) => `
            <div class="upcoming-summary-row">
              <button type="button" class="upcoming-summary-open" data-court-info-target="${escapeAttr(caseData.id)}" aria-label="Перейти к информационной полосе: ${escapeAttr(caseData.name)}">
                <span class="upcoming-summary-date">${formatRuDateTime(hearing.date)}</span>
                <span class="upcoming-summary-case">${escapeHtml(caseData.name)}</span>
                <span class="upcoming-summary-note"><b>Подготовить:</b> ${escapeHtml((hearing.note||'').trim() || 'не указано')}</span>
              </button>
              <span class="upcoming-summary-court">
                <span>${escapeHtml(caseData.court || 'Суд не указан')}</span>
                ${courtSiteLinkHtml(caseData, true)}
              </span>
            </div>
          `).join('')}
        </div>
      </section>`
    : `<section class="upcoming-summary upcoming-summary-empty">
        <div class="upcoming-summary-head"><b>⏰ Ближайшие заседания</b></div>
        <p>Нет назначенных заседаний.</p>
      </section>`;

  el.innerHTML = upcomingHtml
    + `<div class="summary-chip">⚖️ Всего в производстве: <b>${COURT.length}</b></div>`
    + `<div class="summary-chip">📅 Заседаний за 7 дней: <b>${weekCount}</b></div>`;

  el.querySelectorAll('[data-court-info-target]').forEach(row => {
    row.addEventListener('click', () => window.scrollToCourtInfoById(row.dataset.courtInfoTarget));
  });
  el.querySelectorAll('[data-court-site-link]').forEach(link => {
    link.addEventListener('click', event => event.stopPropagation());
    link.addEventListener('keydown', event => event.stopPropagation());
  });
}

function renderCourtHearingWarning(){
  const warning = document.getElementById('court-hearings-warning');
  if(!warning) return;
  const awaiting = courtCasesAwaitingHearingDate();
  if(!awaiting.length){
    warning.hidden = true;
    warning.textContent = '';
    return;
  }
  warning.hidden = false;
  const items = awaiting.map(({caseData, hearing}) => `${caseData.name} (${formatRuDate(hearing.date)})`);
  warning.textContent = `⚠ Новая дата не назначена после заседания: ${items.join(', ')}.`;
}
window.scrollToCourtInfoById = function(id){
  const card = [...document.querySelectorAll('.court-card[data-court-info-id]')]
    .find(item => item.dataset.courtInfoId === id);
  if(!card) return;

  document.querySelectorAll('.court-card-targeted').forEach(item => item.classList.remove('court-card-targeted'));
  if(courtInfoHighlightTimer) clearTimeout(courtInfoHighlightTimer);
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  card.scrollIntoView({ behavior:reduceMotion ? 'auto' : 'smooth', block:'center' });
  card.focus({ preventScroll:true });
  card.classList.add('court-card-targeted');
  courtInfoHighlightTimer = setTimeout(() => {
    card.classList.remove('court-card-targeted');
    courtInfoHighlightTimer = null;
  }, 2400);
};

/* ---------------------------------------------------------------------------
   СВЕРКА ДАТ С САЙТАМИ СУДОВ
--------------------------------------------------------------------------- */
const courtUpdateBackdrop = document.getElementById('court-update-backdrop');
const courtUpdateStatus = document.getElementById('court-update-status');
const courtUpdatePreview = document.getElementById('court-update-preview');
const courtUpdateApplyButton = document.getElementById('court-update-apply');
const courtUpdateButton = document.getElementById('court-update-btn');

function normalizedHearings(hearings){
  const seen = new Set();
  return (Array.isArray(hearings) ? hearings : [])
    .map(h => ({
      date: String(h?.date || '').trim(),
      note: String(h?.note || '').trim()
    }))
    .filter(h => /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?$/.test(h.date))
    .sort((a,b) => a.date.localeCompare(b.date))
    .filter(h => {
      if(seen.has(h.date)) return false;
      seen.add(h.date);
      return true;
    });
}

function mainCaseNumber(value){
  return String(value || '').split(/[~∼〜～]/, 1)[0].trim();
}

function courtUpdateHearingDiff(c, fetched={}){
  const beforeHearings = normalizedHearings(hearingsOf(c));
  const cutoff = todayLocalIso();
  const pastHearings = beforeHearings.filter(h => h.date.slice(0, 10) < cutoff);
  const currentHearings = beforeHearings.filter(h => h.date.slice(0, 10) >= cutoff);
  const sourceHearings = normalizedHearings(fetched.hearings);
  const byDate = new Map(currentHearings.map(h => [h.date, h]));
  const canTransferNotes = sourceHearings.length === currentHearings.length;

  const afterCurrentHearings = sourceHearings.map((h, index) => {
    const exact = byDate.get(h.date);
    // Если единственное назначенное заседание перенесли, сохраняем подготовленную
    // пользователем заметку при одинаковом количестве заседаний.
    const transferredNote = canTransferNotes ? currentHearings[index]?.note : '';
    return { date:h.date, note:exact?.note || transferredNote || '' };
  });
  const afterHearings = normalizedHearings([...pastHearings, ...afterCurrentHearings]);
  const sourceDates = new Set(sourceHearings.map(h => h.date));
  const currentDates = new Set(currentHearings.map(h => h.date));
  const added = afterCurrentHearings.filter(h => !currentDates.has(h.date));
  const removed = currentHearings.filter(h => !sourceDates.has(h.date));
  const hearingsChanged = !deepEqual(beforeHearings, afterHearings);
  const patch = {};
  if(hearingsChanged) patch.hearings = afterHearings;
  const currentCaseNumber = mainCaseNumber(c.caseNumber);
  const fetchedCaseNumber = mainCaseNumber(fetched.caseNumber);
  if(fetchedCaseNumber && currentCaseNumber !== fetchedCaseNumber){
    patch.caseNumber = fetchedCaseNumber;
  }
  if(!String(c.judge || '').trim() && String(fetched.judge || '').trim()){
    patch.judge = String(fetched.judge).trim();
  }

  return {
    id:c.id,
    name:c.name,
    court:c.court || '',
    beforeHearings,
    afterHearings,
    beforeCaseNumber:String(c.caseNumber || '').trim(),
    beforeJudge:String(c.judge || '').trim(),
    added,
    removed,
    patch,
    changed:Object.keys(patch).length > 0
  };
}

function renderCourtUpdatePreview({ diffs=[], errors=[], withoutLinks=0, checked=0 }={}){
  courtUpdateDiffs = diffs.map(diff => ({ ...diff, selected:diff.selected !== false }));

  const lines = [];
  if(courtUpdateDiffs.length){
    lines.push(`<div class="court-update-selection-head">
      <p class="court-update-result-summary">Найдено изменений: <b>${courtUpdateDiffs.length}</b>. Отметьте только те дела, которые нужно обновить.</p>
      <label class="court-update-select-all"><input id="court-update-select-all" type="checkbox" checked> Выбрать все</label>
    </div>`);
    lines.push(courtUpdateDiffs.map(diff => {
      const additions = diff.added.length
        ? `<div class="court-update-change court-update-add"><b>Добавить:</b> ${diff.added.map(h => escapeHtml(formatRuDateTime(h.date))).join(', ')}</div>`
        : '';
      const removals = diff.removed.length
        ? `<div class="court-update-change court-update-remove"><b>Убрать из карточки:</b> ${diff.removed.map(h => escapeHtml(formatRuDateTime(h.date))).join(', ')}</div>`
        : '';
      const caseNumber = diff.patch.caseNumber
        ? `<div class="court-update-change court-update-fill"><b>${diff.beforeCaseNumber ? 'Исправить' : 'Заполнить'} номер дела:</b> ${escapeHtml(diff.patch.caseNumber)}</div>`
        : '';
      const judge = diff.patch.judge
        ? `<div class="court-update-change court-update-fill"><b>Заполнить судью:</b> ${escapeHtml(diff.patch.judge)}</div>`
        : '';
      return `<article class="court-update-case">
        <label class="court-update-case-head">
          <input type="checkbox" data-court-update-select="${escapeAttr(diff.id)}" checked>
          <span><b>${escapeHtml(diff.name)}</b></span>
        </label>
        ${diff.court ? `<p>${escapeHtml(diff.court)}</p>` : ''}
        ${additions}${removals}${caseNumber}${judge}
      </article>`;
    }).join(''));
  }else if(checked){
    lines.push('<p class="court-update-empty">Новых дат или переносов не обнаружено.</p>');
  }

  if(errors.length){
    lines.push(`<section class="court-update-problems"><b>Требуется ручная проверка:</b><ul>${errors.map(item =>
      `<li><b>${escapeHtml(item.name || 'Дело')}</b> — ${escapeHtml(item.message || 'не удалось прочитать страницу суда')}</li>`
    ).join('')}</ul></section>`);
  }
  if(withoutLinks){
    lines.push(`<p class="court-update-note">Без ссылки на дело пропущено карточек: ${withoutLinks}.</p>`);
  }
  courtUpdatePreview.innerHTML = lines.join('');
  courtUpdatePreview.querySelectorAll('[data-court-update-select]').forEach(input => {
    input.addEventListener('change', () => {
      const diff = courtUpdateDiffs.find(item => item.id === input.dataset.courtUpdateSelect);
      if(diff) diff.selected = input.checked;
      refreshCourtUpdateSelectionControls();
    });
  });
  const selectAll = document.getElementById('court-update-select-all');
  selectAll?.addEventListener('change', () => {
    courtUpdateDiffs.forEach(diff => { diff.selected = selectAll.checked; });
    courtUpdatePreview.querySelectorAll('[data-court-update-select]').forEach(input => { input.checked = selectAll.checked; });
    refreshCourtUpdateSelectionControls();
  });
  refreshCourtUpdateSelectionControls();
}

function refreshCourtUpdateSelectionControls(){
  const total = courtUpdateDiffs.length;
  const selected = courtUpdateDiffs.filter(diff => diff.selected).length;
  courtUpdateApplyButton.hidden = total === 0;
  courtUpdateApplyButton.disabled = selected === 0;
  if(total){
    courtUpdateApplyButton.textContent = selected === total
      ? `Применить все изменения (${selected})`
      : `Применить выбранные (${selected})`;
  }
  const selectAll = document.getElementById('court-update-select-all');
  if(selectAll){
    selectAll.checked = total > 0 && selected === total;
    selectAll.indeterminate = selected > 0 && selected < total;
  }
}

function closeCourtUpdate(){
  closeBackdrop(courtUpdateBackdrop);
  courtUpdateDiffs = [];
}

async function requestCourtHearingUpdates(){
  if(!listenerReady.court){
    showToast('Дождитесь загрузки судебного производства.', 'info');
    return;
  }
  if(!COURT_UPDATE_ENDPOINT){
    showToast('Сервис проверки дат ещё не подключён.', 'info');
    return;
  }

  const casesToCheck = COURT
    .filter(c => !isCompletedCourtCase(c))
    .map(c => ({ id:c.id, name:c.name, caseUrl:normalizeWebUrl(c.caseUrl) }))
    .filter(c => c.caseUrl);
  const withoutLinks = COURT.filter(c => !isCompletedCourtCase(c) && !normalizeWebUrl(c.caseUrl)).length;
  if(!casesToCheck.length){
    showToast('У активных дел нет ссылок на страницы суда.', 'info');
    return;
  }

  openBackdrop(courtUpdateBackdrop, '#court-update-close');
  courtUpdateApplyButton.hidden = true;
  courtUpdatePreview.innerHTML = '';
  courtUpdateStatus.textContent = `Проверяем страницы дел: ${casesToCheck.length}…`;
  courtUpdateStatus.className = 'court-update-status is-loading';
  courtUpdateButton.disabled = true;

  let timeoutId;
  try{
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 60000);
    const response = await fetch(COURT_UPDATE_ENDPOINT, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({ cases:casesToCheck }),
      signal:controller.signal
    });
    if(!response.ok) throw new Error(`Сервис вернул HTTP ${response.status}`);
    const payload = await response.json();
    if(!Array.isArray(payload?.results)) throw new Error('Сервис вернул ответ в неизвестном формате.');

    const errors = [];
    const diffs = [];
    payload.results.forEach(result => {
      const c = COURT.find(item => item.id === result?.id);
      if(!c) return;
      if(result.status !== 'ok'){
        errors.push({ name:c.name, message:result.message || 'не удалось прочитать страницу суда' });
        return;
      }
      const diff = courtUpdateHearingDiff(c, result);
      if(diff.changed) diffs.push(diff);
    });

    const unmatched = casesToCheck.filter(c => !payload.results.some(result => result?.id === c.id));
    unmatched.forEach(c => errors.push({ name:c.name, message:'сервис не вернул результат проверки' }));
    courtUpdateStatus.textContent = `Проверено страниц: ${payload.results.length} из ${casesToCheck.length}.`;
    courtUpdateStatus.className = `court-update-status ${errors.length ? 'is-warning' : 'is-success'}`;
    renderCourtUpdatePreview({ diffs, errors, withoutLinks, checked:payload.results.length });
  }catch(err){
    console.error('Проверка дат заседаний', err);
    courtUpdateStatus.textContent = err?.name === 'AbortError'
      ? 'Проверка заняла слишком много времени. Попробуйте ещё раз позднее.'
      : 'Не удалось получить данные с сервиса проверки. Повторите попытку позднее.';
    courtUpdateStatus.className = 'court-update-status is-error';
    renderCourtUpdatePreview();
  }finally{
    if(timeoutId) clearTimeout(timeoutId);
    courtUpdateButton.disabled = false;
  }
}

courtUpdateButton.addEventListener('click', requestCourtHearingUpdates);
document.getElementById('court-update-close').addEventListener('click', closeCourtUpdate);
document.getElementById('court-update-cancel').addEventListener('click', closeCourtUpdate);

courtUpdateApplyButton.addEventListener('click', async event => {
  const selectedDiffs = courtUpdateDiffs.filter(diff => diff.selected);
  if(!selectedDiffs.length) return;
  const stale = selectedDiffs.find(diff => {
    const current = COURT.find(c => c.id === diff.id);
    return !current
      || !deepEqual(normalizedHearings(hearingsOf(current)), diff.beforeHearings)
      || String(current.caseNumber || '').trim() !== diff.beforeCaseNumber
      || String(current.judge || '').trim() !== diff.beforeJudge;
  });
  if(stale){
    showToast(`Карточка «${stale.name}» изменилась во время проверки. Запустите сверку ещё раз.`, 'error');
    return;
  }

  await performAction(event.currentTarget, 'Применение…', async () => {
    const items = selectedDiffs.map(diff => {
      const current = COURT.find(c => c.id === diff.id);
      const before = recordData(current);
      return {
        collection:'courtCases', docId:current.id, label:current.name,
        before, after:{ ...before, ...diff.patch }
      };
    });
    await commitOperation(batch => {
      selectedDiffs.forEach(diff => {
        batch.update(doc(db, 'courtCases', diff.id), diff.patch);
      });
    }, {
      text:`Сверка с сайтами судов: обновлены сведения по делам — ${selectedDiffs.length}.`,
      action:'court.hearing_sync', items,
      meta:{ source:'court-sites', confirmed:true }
    });
    const count = selectedDiffs.length;
    closeCourtUpdate();
    showToast(`Изменения применены: карточек обновлено — ${count}.`, 'success');
  });
});

/* ---------------------------------------------------------------------------
   РЕНДЕР: ЖУРНАЛ
--------------------------------------------------------------------------- */
const FIELD_LABELS = {
  num:'Номер', name:'ФИО', account:'Лицевой счёт', address:'Адрес',
  statusKey:'Статус', note:'Примечание', feeKey:'Госпошлина', protected:'Защищённая запись',
  court:'Суд', caseNumber:'Номер дела', caseUrl:'Ссылка на дело', filedDate:'Дата подачи', judge:'Судья',
  dot:'Статус производства', notes:'Заметки', hearings:'Заседания', nextCaseNum:'Следующий номер'
};

function formatAuditValue(field, value){
  if(value === null || value === undefined || value === '') return '—';
  if(field === 'statusKey') return (STATUS_DEFS[value] || {}).label || String(value);
  if(field === 'feeKey') return value === 'paid' ? 'Оплачена' : 'Не оплачена';
  if(field === 'dot') return ({blue:'В процессе', done:'Удовлетворено', denied:'Отказано', partial:'Удовлетворено частично'})[value] || String(value);
  if(field === 'protected') return value ? 'Да' : 'Нет';
  if(field === 'filedDate') return formatRuDate(value);
  if(field === 'hearings'){
    if(!Array.isArray(value) || !value.length) return 'Нет заседаний';
    return value.map(h => `${formatRuDateTime(h.date)}${h.note ? ` — ${h.note}` : ''}`).join('; ');
  }
  if(typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function auditChanges(item){
  const keys = [...new Set([...Object.keys(item.before || {}), ...Object.keys(item.after || {})])]
    .filter(k => !['notesFixed'].includes(k));
  if(item.before === null){
    return keys.map(k => ({ label:FIELD_LABELS[k] || k, before:'—', after:formatAuditValue(k, item.after?.[k]) }));
  }
  if(item.after === null){
    return keys.map(k => ({ label:FIELD_LABELS[k] || k, before:formatAuditValue(k, item.before?.[k]), after:'—' }));
  }
  return keys.filter(k => !deepEqual(item.before?.[k], item.after?.[k])).map(k => ({
    label: FIELD_LABELS[k] || k,
    before: formatAuditValue(k, item.before?.[k]),
    after: formatAuditValue(k, item.after?.[k])
  }));
}

function logActionLabel(action){
  return ({
    'case.update':'Изменение дела', 'case.create':'Добавление должника', 'case.delete':'Удаление должника',
    'court.update':'Изменение судопроизводства', 'court.create':'Добавление в судопроизводство', 'court.delete':'Удаление из судопроизводства',
    'import':'Массовый импорт', 'backup.restore':'Восстановление копии', 'undo':'Отмена операции',
    'system.migration':'Системная сверка данных', 'note':'Заметка'
  })[action] || 'Изменение';
}

function renderLog(){
  const el = document.getElementById('log-list');
  if(!el) return;
  el.innerHTML = LOGS.map(l => {
    const items = Array.isArray(l.items) ? l.items : [];
    const details = items.length ? `
      <details class="log-details">
        <summary>Подробности (${items.length})</summary>
        <div class="log-detail-list">
          ${items.map(item => {
            const changes = auditChanges(item);
            return `<article class="log-target">
              <h4>${escapeHtml(item.label || `${item.collection}/${item.docId}`)}</h4>
              ${changes.length ? `<dl>${changes.map(ch => `
                <div class="log-change"><dt>${escapeHtml(ch.label)}</dt><dd><span class="value-before">${escapeHtml(ch.before)}</span><span class="change-arrow">→</span><span class="value-after">${escapeHtml(ch.after)}</span></dd></div>
              `).join('')}</dl>` : '<p class="log-no-change">Состав данных не изменился.</p>'}
            </article>`;
          }).join('')}
        </div>
      </details>` : '';
    const canUndo = l.reversible && !l.undoneAt && items.length;
    const undone = l.undoneAt ? `<span class="log-undone">Отменено ${formatRuDateTimeFromMs(l.undoneAt)}</span>` : '';
    return `<li class="log-entry ${l.undoneAt ? 'is-undone' : ''}">
      <div class="log-entry-head">
        <div>
          <span class="log-date">${formatRuDate(l.date)}${l.createdAt ? `, ${formatTimeFromMs(l.createdAt)}` : ''}</span>
          <span class="log-action">${escapeHtml(logActionLabel(l.action))}</span>
          <span class="log-actor">${escapeHtml(l.actorLabel || 'Старая запись')}</span>
        </div>
        ${undone}
      </div>
      <div class="log-text">${escapeHtml(l.text)}</div>
      ${details}
      ${canUndo ? `<button type="button" class="btn-undo" data-log-id="${escapeAttr(l.id)}">Отменить это изменение</button>` : ''}
    </li>`;
  }).join('') || '<p style="color:var(--ink-soft)">Журнал пуст.</p>';

  el.querySelectorAll('.btn-undo').forEach(btn => {
    btn.addEventListener('click', async () => {
      const log = LOGS.find(x => x.id === btn.dataset.logId);
      if(!log) return;
      if(!confirm(`Отменить операцию «${log.text}»?`)) return;
      await performAction(btn, 'Отмена…', async () => undoOperation(log));
    });
  });
}

function renderBackups(){
  const el = document.getElementById('backup-list');
  if(!el) return;
  el.innerHTML = BACKUPS.map(b => `
    <article class="backup-card">
      <div class="backup-info">
        <b>${escapeHtml(b.name || 'Резервная копия')}</b>
        <span>${formatRuDate(b.date)}${b.createdAt ? `, ${formatTimeFromMs(b.createdAt)}` : ''} · дел: ${(b.cases||[]).length} · судебных карточек: ${(b.courtCases||[]).length}</span>
      </div>
      <div class="backup-actions">
        <button type="button" class="btn-ghost backup-download" data-backup-id="${escapeAttr(b.id)}">Скачать JSON</button>
        <button type="button" class="btn-danger backup-restore" data-backup-id="${escapeAttr(b.id)}">Восстановить</button>
      </div>
    </article>
  `).join('') || '<p class="backup-empty">Резервных копий пока нет.</p>';

  el.querySelectorAll('.backup-download').forEach(btn => btn.addEventListener('click', () => {
    const backup = BACKUPS.find(x => x.id === btn.dataset.backupId);
    if(backup) downloadJson(backup, `DOSTUP-backup-${backup.date || todayLocalIso()}.json`);
  }));
  el.querySelectorAll('.backup-restore').forEach(btn => btn.addEventListener('click', async () => {
    const backup = BACKUPS.find(x => x.id === btn.dataset.backupId);
    if(!backup) return;
    if(!confirm(`Полностью восстановить реестр и судебное производство из копии «${backup.name || backup.id}»?\n\nТекущее состояние будет сохранено в подробном журнале, поэтому эту операцию тоже можно будет отменить.`)) return;
    await performAction(btn, 'Восстановление…', async () => restoreBackup(backup));
  }));
}

async function createManualBackup(){
  const snapshot = await readWorkingSnapshot();
  const createdAt = Date.now();
  await addDoc(collection(db, 'backups'), {
    name: `Ручной снимок ${formatRuDate(todayLocalIso())}, ${formatTimeFromMs(createdAt)}`,
    type:'manual', date:todayLocalIso(), createdAt,
    actorRole:currentRole(), actorLabel:actorLabel(), version:2,
    ...snapshot
  });
}

async function restoreBackup(backup){
  const current = await readWorkingSnapshot();
  const items = [];
  const targetCollections = [
    ['cases', current.cases || [], backup.cases || []],
    ['courtCases', current.courtCases || [], backup.courtCases || []]
  ];
  targetCollections.forEach(([collectionName, beforeList, afterList]) => {
    const beforeMap = new Map(beforeList.map(x => [x.id, x.data]));
    const afterMap = new Map(afterList.map(x => [x.id, x.data]));
    const ids = new Set([...beforeMap.keys(), ...afterMap.keys()]);
    ids.forEach(id => {
      const before = beforeMap.has(id) ? beforeMap.get(id) : null;
      const after = afterMap.has(id) ? afterMap.get(id) : null;
      if(deepEqual(before, after)) return;
      const labelData = after || before || {};
      items.push({ collection:collectionName, docId:id, label:labelData.name || `${collectionName}/${id}`, before, after });
    });
  });

  const maxNum = Math.max(0, ...(backup.cases || []).map(x => Number(x.data?.num)||0));
  const targetCounter = backup.counters || { nextCaseNum:maxNum + 1 };
  if(!deepEqual(current.counters, targetCounter)){
    items.push({ collection:'meta', docId:'counters', label:'Счётчик номеров', before:current.counters, after:targetCounter });
  }
  if(!items.length){ showToast('Текущее состояние уже совпадает с этой копией.', 'info'); return; }
  if(items.length > 450) throw new Error('Слишком много документов для одного атомарного восстановления.');

  await commitOperation(batch => {
    items.forEach(item => {
      const ref = doc(db, item.collection, item.docId);
      if(item.after === null) batch.delete(ref);
      else batch.set(ref, item.after);
    });
  }, {
    text:`Восстановлена резервная копия «${backup.name || backup.id}».`,
    action:'backup.restore', items,
    meta:{ backupId:backup.id }
  });
  showToast('Резервная копия восстановлена.', 'success');
}

async function undoOperation(log){
  if(currentRole() !== 'admin') throw new ValidationError('Недостаточно прав.');
  if(!log.reversible || log.undoneAt || !Array.isArray(log.items) || !log.items.length){
    showToast('Эту запись нельзя отменить.', 'error');
    throw new ValidationError();
  }
  const checks = await Promise.all(log.items.map(async item => {
    const snap = await getDoc(doc(db, item.collection, item.docId));
    return { item, current:snap.exists() ? snap.data() : null };
  }));
  const conflicts = checks.filter(x => !deepEqual(x.current, x.item.after));
  if(conflicts.length){
    showToast(`Отмена заблокирована: после этой операции ${conflicts.length} запись(и) уже изменялись. Сначала отмените более поздние изменения.`, 'error');
    throw new ValidationError();
  }

  const inverseItems = log.items.map(item => ({
    collection:item.collection, docId:item.docId, label:item.label,
    before:item.after, after:item.before
  }));
  const batch = writeBatch(db);
  inverseItems.forEach(item => {
    const ref = doc(db, item.collection, item.docId);
    if(item.after === null) batch.delete(ref);
    else batch.set(ref, item.after);
  });
  const undoLogRef = doc(collection(db, 'logs'));
  batch.update(doc(db, 'logs', log.id), {
    undoneAt:Date.now(), undoneByActor:actorLabel(), undoneByLogId:undoLogRef.id
  });
  batch.set(undoLogRef, operationLogPayload({
    text:`Отменена операция: ${log.text}`,
    action:'undo', items:inverseItems, sourceLogId:log.id
  }));
  await batch.commit();
  showToast('Изменение отменено.', 'success');
}

const createBackupBtn = document.getElementById('create-backup-btn');
if(createBackupBtn){
  createBackupBtn.addEventListener('click', async () => {
    await performAction(createBackupBtn, 'Создание…', async () => {
      await createManualBackup();
      showToast('Резервная копия создана.', 'success');
    });
  });
}

/* ---------------------------------------------------------------------------
   МОДАЛЬНОЕ ОКНО: КАРТОЧКА ДЕЛА / СУДОПРОИЗВОДСТВА
--------------------------------------------------------------------------- */
const backdrop = document.getElementById('modal-backdrop');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');
const modalDelete = document.getElementById('modal-delete');

let activeRecord = null;   // {kind:'case'|'newcase'|'court', data:{...}}

function openBackdrop(el, focusSelector){
  lastFocusedElement = document.activeElement;
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => {
    const target = focusSelector ? el.querySelector(focusSelector) : null;
    (target || el.querySelector('input, select, textarea, button'))?.focus();
  });
}

function closeBackdrop(el){
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
  if(lastFocusedElement && document.contains(lastFocusedElement)) lastFocusedElement.focus();
  lastFocusedElement = null;
}

function closeModal(){
  closeBackdrop(backdrop);
  activeRecord = null;
  modalHearings = [];
}
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-cancel').addEventListener('click', closeModal);
modalBody.addEventListener('input', e => e.target.classList.remove('is-invalid'));
modalBody.addEventListener('change', e => e.target.classList.remove('is-invalid'));

function statusOptionsHtml(selected){
  return STATUS_ORDER.map(k => `<option value="${k}" ${k===selected?'selected':''}>${STATUS_DEFS[k].icon} ${STATUS_DEFS[k].label}</option>`).join('');
}

function openCaseModal(c){
  activeRecord = { kind:'case', data:c };
  modalTitle.textContent = `№${c.num} · ${c.name}`;
  modalDelete.hidden = !!c.protected;
  modalBody.innerHTML = `
    <div class="field"><label>ФИО</label><div class="readonly-text">${escapeHtml(c.name)}</div></div>
    <div class="field-row">
      <div class="field"><label>Лицевой счёт</label><div class="readonly-text">${escapeHtml(c.account||'—')}</div></div>
      <div class="field"><label>Адрес</label><div class="readonly-text">${escapeHtml(c.address||'—')}</div></div>
    </div>
    <div class="field"><label>Статус</label><select id="f-statusKey">${statusOptionsHtml(c.statusKey)}</select></div>
    <div class="field"><label>Примечание</label><textarea id="f-note">${escapeHtml(c.note||'')}</textarea></div>
    <div class="field"><label>Госпошлина</label>
      <select id="f-feeKey">
        <option value="unpaid" ${c.feeKey!=='paid'?'selected':''}>Не оплачена</option>
        <option value="paid" ${c.feeKey==='paid'?'selected':''}>Оплачена</option>
      </select>
    </div>
  `;
  openBackdrop(backdrop, '#f-statusKey');
}

function openNewCaseModal(){
  activeRecord = { kind:'newcase', data:{} };
  modalTitle.textContent = 'Новый должник';
  modalDelete.hidden = true;
  modalBody.innerHTML = `
    <div class="field"><label>ФИО</label><input id="f-name" placeholder="Фамилия Имя Отчество"></div>
    <div class="field-row">
      <div class="field"><label>Лицевой счёт</label><input id="f-account"></div>
      <div class="field"><label>Адрес</label><input id="f-address"></div>
    </div>
    <div class="field"><label>Статус</label><select id="f-statusKey">${statusOptionsHtml('draft')}</select></div>
    <div class="field"><label>Примечание</label><textarea id="f-note"></textarea></div>
    <div class="field"><label>Госпошлина</label>
      <select id="f-feeKey"><option value="unpaid" selected>Не оплачена</option><option value="paid">Оплачена</option></select>
    </div>
  `;
  openBackdrop(backdrop, '#f-name');
}
document.getElementById('add-case-btn').addEventListener('click', openNewCaseModal);

function renderHearingsList(){
  const el = document.getElementById('hearings-list');
  if(!el) return;
  if(!modalHearings.length){
    el.innerHTML = `<p style="color:var(--ink-soft);font-size:13px;margin:0 0 8px">Заседаний пока нет.</p>`;
    return;
  }
  const sorted = modalHearings.slice().sort((a,b) => new Date(a.date) - new Date(b.date));
  el.innerHTML = sorted.map(h => {
    const idx = modalHearings.indexOf(h);
    return `<div class="hearing-item">
      <div><b>${formatRuDateTime(h.date)}</b>${h.note ? ' — '+escapeHtml(h.note) : ''}</div>
      <button type="button" class="hearing-remove" data-idx="${idx}">✕</button>
    </div>`;
  }).join('');
  el.querySelectorAll('.hearing-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      modalHearings.splice(Number(btn.dataset.idx), 1);
      renderHearingsList();
    });
  });
}

function addPendingHearingFromInputs(){
  const dateInput = document.getElementById('f-newHearingDate');
  const hourInput = document.getElementById('f-newHearingHour');
  const minuteInput = document.getElementById('f-newHearingMinute');
  const noteInput = document.getElementById('f-newHearingNote');
  if(!dateInput || !hourInput || !minuteInput || !noteInput) return 'empty';

  const datePart = dateInput.value;
  const noteValue = noteInput.value.trim();
  if(!datePart && !noteValue) return 'empty';
  if(!datePart){
    markInvalid('f-newHearingDate', 'Укажите дату заседания.');
    return 'invalid';
  }
  const dateValue = `${datePart}T${hourInput.value}:${minuteInput.value}`;
  if(modalHearings.some(h => h.date === dateValue)){
    markInvalid('f-newHearingDate', 'Заседание на эту дату и время уже добавлено.');
    return 'invalid';
  }

  modalHearings.push({ date:dateValue, note:noteValue });
  dateInput.value = '';
  noteInput.value = '';
  renderHearingsList();
  return 'added';
}

function timePartOptions(max, step, selected){
  const values = [];
  for(let value = 0; value <= max; value += step){
    const padded = String(value).padStart(2, '0');
    values.push(`<option value="${padded}" ${padded === selected ? 'selected' : ''}>${padded}</option>`);
  }
  return values.join('');
}

function enableWholeDatePicker(input){
  if(!input) return;
  input.addEventListener('pointerdown', event => {
    if(typeof input.showPicker !== 'function') return;
    try{
      input.focus({ preventScroll:true });
      input.showPicker();
      event.preventDefault();
    }catch(_err){ /* Браузер сам обработает обычный ввод. */ }
  });
  input.addEventListener('keydown', event => {
    if(!['Enter', ' '].includes(event.key) || typeof input.showPicker !== 'function') return;
    try{
      input.showPicker();
      event.preventDefault();
    }catch(_err){ /* Нативный fallback остаётся доступен. */ }
  });
}

function openCourtModal(c){
  activeRecord = { kind:'court', data:c };
  modalHearings = JSON.parse(JSON.stringify(
    hearingsOf(c).length ? hearingsOf(c) : (c.hearingDate ? [{date:c.hearingDate, note:''}] : [])
  ));
  const isNew = !c.id;
  modalTitle.textContent = isNew ? 'Новое дело в производстве' : `Судебное дело · ${c.name}`;
  modalDelete.hidden = isNew;

  const knownCourts = [...new Set(COURT.map(x => x.court).filter(Boolean))].sort();
  const currentCourtVal = c.court && knownCourts.includes(c.court) ? c.court : (c.court ? '__other__' : '');

  const availableCases = CASES
    .filter(cc => !COURT.some(existing => normalizeAccount(existing.account) === normalizeAccount(cc.account)))
    .sort((a,b)=>a.num-b.num);
  const debtorField = isNew
    ? `<div class="field"><label>Должник</label><select id="f-caseSelect" ${availableCases.length ? '' : 'disabled'}>
        ${availableCases.length ? availableCases.map(cc =>
          `<option value="${escapeAttr(cc.account)}" data-name="${escapeAttr(cc.name)}">${String(cc.num).padStart(2,'0')}. ${escapeHtml(cc.name)}</option>`
        ).join('') : '<option value="">Все должники уже добавлены в судебное производство</option>'}
      </select></div>`
    : `<div class="field"><label>Должник</label><div class="readonly-text">${escapeHtml(c.name)} (л/с ${escapeHtml(c.account||'—')})</div></div>`;

  modalBody.innerHTML = `
    ${debtorField}
    <div class="field-row">
      <div class="field"><label>Суд</label>
        <select id="f-court-select">
          <option value="">— выбрать —</option>
          ${knownCourts.map(cv => `<option value="${escapeAttr(cv)}" ${cv===currentCourtVal?'selected':''}>${escapeHtml(cv)}</option>`).join('')}
          <option value="__other__" ${currentCourtVal==='__other__'?'selected':''}>Другое (указать)</option>
        </select>
        <input id="f-court-other" placeholder="Название суда" style="margin-top:6px;${currentCourtVal==='__other__'?'':'display:none'}" value="${currentCourtVal==='__other__'?escapeAttr(c.court||''):''}">
      </div>
      <div class="field"><label>Номер дела</label><input id="f-caseNumber" value="${escapeAttr(c.caseNumber||'')}"></div>
    </div>
    <div class="field">
      <label for="f-caseUrl">Ссылка на дело на сайте суда</label>
      <input type="url" id="f-caseUrl" value="${escapeAttr(c.caseUrl||'')}" placeholder="https://...">
      <p class="field-hint">После сохранения кнопка перехода появится в карточке и в ближайших заседаниях.</p>
    </div>
    <div class="field-row">
      <div class="field"><label>Дата подачи</label><input type="date" id="f-filedDate" value="${c.filedDate||''}"></div>
      <div class="field"><label>Судья</label><input id="f-judge" value="${escapeAttr(c.judge||'')}" placeholder="Фамилия И.О."></div>
    </div>
    <div class="field"><label>Статус производства</label>
      <select id="f-dot">
        <option value="blue" ${c.dot==='blue'?'selected':''}>🔵 В процессе</option>
        <option value="done" ${c.dot==='done'?'selected':''}>✅ Удовлетворено</option>
        <option value="denied" ${c.dot==='denied'?'selected':''}>❌ Отказано</option>
        <option value="partial" ${c.dot==='partial'?'selected':''}>🟠 Удовлетворено частично</option>
      </select>
    </div>
    <div class="field">
      <label>Заседания</label>
      <div id="hearings-list"></div>
      <div class="hearing-add-row">
        <div class="hearing-input-block">
          <label for="f-newHearingDate">Дата</label>
          <input type="date" id="f-newHearingDate">
        </div>
        <div class="hearing-input-block">
          <span class="hearing-input-label">Время</span>
          <div class="hearing-time-selects">
            <select id="f-newHearingHour" aria-label="Часы заседания">${timePartOptions(23, 1, '09')}</select>
            <span aria-hidden="true">:</span>
            <select id="f-newHearingMinute" aria-label="Минуты заседания">${timePartOptions(55, 5, '00')}</select>
          </div>
        </div>
        <div class="hearing-input-block hearing-note-block">
          <label for="f-newHearingNote">Что подготовить</label>
          <input id="f-newHearingNote" placeholder="Документы или пояснение">
        </div>
        <button type="button" id="btn-add-hearing" class="btn-ghost">+ Добавить заседание</button>
      </div>
    </div>
    <div class="field"><label>Заметки</label><textarea id="f-notes">${escapeHtml(c.notes||'')}</textarea></div>
  `;
  renderHearingsList();

  document.getElementById('btn-add-hearing').addEventListener('click', () => {
    addPendingHearingFromInputs();
  });
  enableWholeDatePicker(document.getElementById('f-newHearingDate'));

  const courtSelect = document.getElementById('f-court-select');
  courtSelect.addEventListener('change', () => {
    document.getElementById('f-court-other').style.display = courtSelect.value === '__other__' ? 'block' : 'none';
  });

  openBackdrop(backdrop, isNew ? '#f-caseSelect' : '#f-court-select');
}
document.getElementById('add-court-btn').addEventListener('click', () => {
  const available = CASES.some(cc => !COURT.some(c => normalizeAccount(c.account) === normalizeAccount(cc.account)));
  if(!available){ showToast('Все должники уже добавлены в судебное производство.', 'info'); return; }
  openCourtModal({});
});

document.getElementById('modal-save').addEventListener('click', async () => {
  if(!activeRecord) return;
  const saveBtn = document.getElementById('modal-save');

  await performAction(saveBtn, 'Сохранение…', async () => {
    if(activeRecord.kind === 'case'){
      const c = activeRecord.data;
      const statusKey = val('f-statusKey');
      const patch = { statusKey, note: val('f-note').trim(), feeKey: val('f-feeKey') };
      const unchanged = patch.statusKey === c.statusKey && patch.note === (c.note||'') && patch.feeKey === c.feeKey;
      if(unchanged){ showToast('Изменений нет.', 'info'); closeModal(); return; }
      const before = recordData(c);
      const after = { ...before, ...patch };
      await commitOperation(
        batch => batch.update(doc(db, 'cases', c.id), patch),
        {
          text:`${c.name}: карточка обновлена.`, action:'case.update',
          items:[{ collection:'cases', docId:c.id, label:c.name, before, after }]
        }
      );

    } else if(activeRecord.kind === 'newcase'){
      const name = val('f-name').trim();
      const account = normalizeAccount(val('f-account'));
      if(!name){ markInvalid('f-name', 'Укажите ФИО.'); throw new ValidationError(); }
      if(!account){ markInvalid('f-account', 'Укажите лицевой счёт.'); throw new ValidationError(); }
      if(!/^\d+$/.test(account)){ markInvalid('f-account', 'Лицевой счёт должен содержать только цифры.'); throw new ValidationError(); }
      if(CASES.some(c => normalizeAccount(c.account) === account)){
        markInvalid('f-account', 'Должник с таким лицевым счётом уже есть в реестре.');
        throw new ValidationError();
      }

      let createdNum = null;
      const caseRef = doc(collection(db, 'cases'));
      const logRef = doc(collection(db, 'logs'));
      const counterRef = doc(db, 'meta', 'counters');
      const localNext = CASES.reduce((max, c) => Math.max(max, Number(c.num)||0), 0) + 1;
      const payload = {
        name, account, address: val('f-address').trim(),
        statusKey: val('f-statusKey'), note: val('f-note').trim(),
        feeKey: val('f-feeKey'), protected: false, notesFixed: true
      };

      await runTransaction(db, async transaction => {
        const counterSnap = await transaction.get(counterRef);
        const counterBefore = counterSnap.exists() ? counterSnap.data() : null;
        const storedNext = counterBefore ? Number(counterBefore.nextCaseNum) || localNext : localNext;
        createdNum = Math.max(storedNext, localNext);
        const counterAfter = { ...(counterBefore || {}), nextCaseNum: createdNum + 1 };
        transaction.set(counterRef, counterAfter);
        const createdData = { num:createdNum, ...payload };
        transaction.set(caseRef, createdData);
        transaction.set(logRef, operationLogPayload({
          text:`${name}: добавлен новый должник в реестр (№${createdNum}).`,
          action:'case.create',
          items:[
            { collection:'cases', docId:caseRef.id, label:name, before:null, after:createdData },
            { collection:'meta', docId:'counters', label:'Счётчик номеров', before:counterBefore, after:counterAfter }
          ]
        }));
      });

    } else {
      const c = activeRecord.data;
      const isNew = !c.id;
      const courtSelectVal = val('f-court-select');
      const finalCourt = (courtSelectVal === '__other__' ? val('f-court-other') : courtSelectVal).trim();
      let name = c.name, account = normalizeAccount(c.account);
      if(isNew){
        const sel = document.getElementById('f-caseSelect');
        account = normalizeAccount(sel.value);
        name = sel.selectedOptions[0] ? sel.selectedOptions[0].dataset.name : '';
      }
      if(!account || !name){ markInvalid('f-caseSelect', 'Выберите должника.'); throw new ValidationError(); }
      if(!finalCourt){
        markInvalid(courtSelectVal === '__other__' ? 'f-court-other' : 'f-court-select', 'Укажите суд.');
        throw new ValidationError();
      }
      if(!val('f-filedDate')){ markInvalid('f-filedDate', 'Укажите дату подачи иска.'); throw new ValidationError(); }
      const rawCaseUrl = val('f-caseUrl').trim();
      const caseUrl = normalizeWebUrl(rawCaseUrl);
      if(rawCaseUrl && !caseUrl){
        markInvalid('f-caseUrl', 'Укажите корректную ссылку, начинающуюся с http:// или https://.');
        throw new ValidationError();
      }
      if(isNew && COURT.some(item => normalizeAccount(item.account) === account)){
        showToast('Этот должник уже есть в судебном производстве.', 'error');
        throw new ValidationError();
      }

      // Если пользователь заполнил новую дату/подготовку, но не нажал
      // отдельную кнопку «Добавить заседание», общая кнопка «Сохранить»
      // всё равно добавляет заседание в карточку.
      const pendingHearingResult = addPendingHearingFromInputs();
      if(pendingHearingResult === 'invalid') throw new ValidationError();

      const updated = {
        name, account,
        court: finalCourt, caseNumber: val('f-caseNumber').trim(), caseUrl,
        filedDate: val('f-filedDate'), judge: val('f-judge').trim(),
        dot: val('f-dot'), notes: val('f-notes').trim(),
        hearings: modalHearings.slice().sort((a,b) => new Date(a.date) - new Date(b.date))
      };
      const courtRef = isNew ? doc(collection(db, 'courtCases')) : doc(db, 'courtCases', c.id);
      const before = isNew ? null : recordData(c);
      const after = isNew ? updated : { ...before, ...updated };
      if(!isNew && deepEqual(before, after)){ showToast('Изменений нет.', 'info'); closeModal(); return; }
      await commitOperation(
        batch => isNew ? batch.set(courtRef, updated) : batch.update(courtRef, updated),
        {
          text:isNew
            ? `${updated.name}: заведено дело в судебном производстве (${updated.court}).`
            : `${updated.name}: обновлена карточка судебного производства.`,
          action:isNew ? 'court.create' : 'court.update',
          items:[{ collection:'courtCases', docId:courtRef.id, label:updated.name, before, after }]
        }
      );
    }
    closeModal();
    showToast('Изменения сохранены.', 'success');
  });
});

modalDelete.addEventListener('click', async () => {
  if(!activeRecord || !activeRecord.data.id) return;
  if(activeRecord.kind === 'case' && activeRecord.data.protected) return;
  if(activeRecord.kind === 'case' && COURT.some(c => normalizeAccount(c.account) === normalizeAccount(activeRecord.data.account))){
    showToast('Сначала удалите связанное дело из судебного производства.', 'error');
    return;
  }
  if(!confirm(`Удалить запись «${activeRecord.data.name}»?\n\nПри необходимости операцию можно будет отменить через журнал администратора.`)) return;

  await performAction(modalDelete, 'Удаление…', async () => {
    const coll = activeRecord.kind === 'case' ? 'cases' : 'courtCases';
    const record = activeRecord.data;
    const before = recordData(record);
    await commitOperation(
      batch => batch.delete(doc(db, coll, record.id)),
      {
        text:`Запись «${record.name}» удалена.`,
        action:activeRecord.kind === 'case' ? 'case.delete' : 'court.delete',
        items:[{ collection:coll, docId:record.id, label:record.name, before, after:null }]
      }
    );
    closeModal();
    showToast('Запись удалена.', 'success');
  });
});

/* ---------------------------------------------------------------------------
   ВКЛАДКИ
--------------------------------------------------------------------------- */
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if(tab.classList.contains('active')) return;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active','panel-enter'));
    tab.classList.add('active');
    const panel = document.getElementById('tab-' + tab.dataset.tab);
    panel.classList.add('active');
    requestAnimationFrame(() => panel.classList.add('panel-enter'));
  });
});
window.switchTabByName = function(name){
  const btn = document.querySelector(`.tab[data-tab="${name}"]`);
  if(btn) btn.click();
};

// При самой первой загрузке страницы ни один клик по вкладке ещё не
// произошёл — без этого стартовая активная вкладка оставалась невидимой
// (opacity:0) до первого переключения между вкладками.
document.querySelectorAll('.tab-panel.active').forEach(p => {
  requestAnimationFrame(() => p.classList.add('panel-enter'));
});

/* ---------------------------------------------------------------------------
   СВОДКА ДЛЯ TELEGRAM
--------------------------------------------------------------------------- */
function compactText(value){
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function shortPersonName(value){
  const parts = compactText(value).split(' ').filter(Boolean);
  if(parts.length <= 1) return parts[0] || '—';
  const surname = parts[0];
  const restJoined = parts.slice(1).join('');
  if(/^(?:[А-ЯЁA-Z]\.){1,4}$/u.test(restJoined)) return `${surname} ${restJoined}`;
  const initials = parts.slice(1, 3)
    .map(part => (part.match(/[А-ЯЁA-Z]/iu) || [part.charAt(0)])[0])
    .filter(Boolean)
    .map(letter => `${letter.toUpperCase()}.`)
    .join('');
  return initials ? `${surname} ${initials}` : surname;
}

function lowerFirst(value){
  const text = compactText(value);
  return text ? text.charAt(0).toLocaleLowerCase('ru-RU') + text.slice(1) : '';
}

function linkedCourtCase(caseData){
  const account = normalizeAccount(caseData?.account);
  return COURT.find(c => normalizeAccount(c.account) === account) || null;
}

function hearingsWithinDays(days = 30){
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + days);
  end.setHours(23, 59, 59, 999);

  return COURT.filter(caseData => !isCompletedCourtCase(caseData)).flatMap(caseData => hearingsOf(caseData).map(hearing => ({
    caseData,
    hearing,
    dt: hearingDateObject(hearing?.date)
  })))
    .filter(item => item.dt && item.dt >= now && item.dt <= end)
    .sort((a,b) => a.dt - b.dt || (a.caseData.name || '').localeCompare(b.caseData.name || '', 'ru'));
}

function telegramDeadlineLine({ caseData, hearing }){
  const details = [];
  if(compactText(caseData.court)) details.push(compactText(caseData.court));
  if(compactText(caseData.judge)) details.push(`судья ${compactText(caseData.judge)}`);
  let line = `${formatRuDateTime(hearing.date)} — судебное заседание: ${shortPersonName(caseData.name)}`;
  if(details.length) line += ` (${details.join(', ')})`;
  if(compactText(hearing.note)) line += ` — подготовить ${lowerFirst(hearing.note)}`;
  return line;
}

function courtSortNumber(c){
  const linked = CASES.find(item => normalizeAccount(item.account) === normalizeAccount(c.account));
  return Number(linked?.num) || Number.MAX_SAFE_INTEGER;
}

function telegramCourtResult(c){
  const result = c.dot === 'done'
    ? 'иск удовлетворён'
    : (c.dot === 'partial' ? 'иск удовлетворён частично' : 'в удовлетворении иска отказано');
  const decisionDate = courtDecisionDateOf(c);
  return `${result}${decisionDate ? `, решение от ${formatRuDate(decisionDate)}` : ', дата решения не указана'}`;
}

function telegramCourtLine(c){
  const icon = DOT[c.dot] || '🔵';
  const nearest = nearestUpcomingHearingOf(c);
  const completed = isCompletedCourtCase(c);
  const registryNumber = courtSortNumber(c);
  const parts = [
    compactText(c.court) || 'суд не указан',
    compactText(c.caseNumber) ? `дело №${compactText(c.caseNumber)}` : 'номер дела не указан',
    compactText(c.judge) ? `судья ${compactText(c.judge)}` : 'судья не указан',
    completed ? telegramCourtResult(c) : (nearest ? `ближайшее заседание ${formatRuDateTime(nearest.date)}` : 'ближайшее заседание не назначено')
  ];
  const prefix = Number.isFinite(registryNumber) && registryNumber !== Number.MAX_SAFE_INTEGER ? `${registryNumber}. ` : '';
  return `${icon} ${prefix}${compactText(c.name) || 'ФИО не указано'} — ${parts.join(', ')}\n   ${telegramEquipmentLine(c)}`;
}

const TELEGRAM_EQUIPMENT_ICONS = {
  stove:'▦',
  waterHeater:'💧',
  boiler:'🔥',
  meter:'◉'
};

function telegramEquipmentLine(c){
  const equipment = courtEquipmentOf(c);
  if(!equipment.length) return 'Оборудование: не указано';
  const items = equipment.map(item => {
    const icon = TELEGRAM_EQUIPMENT_ICONS[item.type] || '•';
    const quantity = Math.max(1, Number(item.quantity) || 1);
    return `${icon} ${compactText(item.label) || 'Оборудование'} ×${quantity}`;
  });
  return `Оборудование: ${items.join(' · ')}`;
}

function telegramClosedCaseLine(c){
  const status = c.statusKey === 'paid' ? 'оплачено' : 'отключено';
  const note = compactText(c.note);
  return `⚪️ ${c.num}. ${shortPersonName(c.name)} — ${status}${note ? ` (${note})` : ''}`;
}

function buildTelegramSummary(){
  const lines = [`📊 Работа по искам об обеспечении доступа на ${formatRuDate(todayLocalIso())}`, ''];
  const deadlines = hearingsWithinDays(30);
  lines.push('⏰ БЛИЖАЙШИЕ СУДЕБНЫЕ ЗАСЕДАНИЯ');
  if(deadlines.length) deadlines.forEach(item => lines.push(telegramDeadlineLine(item)));
  else lines.push('Назначенных заседаний на ближайшие 30 дней нет.');

  lines.push('', '━━━━━━━━━━━━━━━━━━━━', `⚖️ СУДЕБНОЕ ПРОИЗВОДСТВО (${COURT.length} ${pluralDela(COURT.length)})`);
  if(COURT.length){
    COURT.slice()
      .sort(compareCourtCases)
      .forEach(c => lines.push(telegramCourtLine(c)));
  } else {
    lines.push('Дел в судебном производстве пока нет.');
  }

  const closedCases = CASES
    .filter(c => ['disconnected','paid'].includes(c.statusKey))
    .sort((a,b) => Number(a.num) - Number(b.num));
  lines.push('', '━━━━━━━━━━━━━━━━━━━━', `⚪️ ОТКЛЮЧЕНО / ОПЛАЧЕНО (${closedCases.length})`);
  if(closedCases.length) closedCases.forEach(c => lines.push(telegramClosedCaseLine(c)));
  else lines.push('Должников в этом разделе нет.');
  return lines.join('\n');
}

const telegramBackdrop = document.getElementById('telegram-backdrop');
const telegramText = document.getElementById('telegram-summary-text');
const telegramCharCount = document.getElementById('telegram-char-count');

function updateTelegramCharCount(){
  const count = telegramText.value.length;
  telegramCharCount.textContent = `${count} ${count === 1 ? 'знак' : (count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'знака' : 'знаков')}`;
  telegramCharCount.classList.toggle('is-over-limit', count > 4096);
}

function openTelegramSummary(){
  if(!listenerReady.cases || !listenerReady.court){
    showToast('Данные ещё загружаются. Повторите через несколько секунд.', 'info');
    return;
  }
  telegramText.value = buildTelegramSummary();
  updateTelegramCharCount();
  openBackdrop(telegramBackdrop, '#telegram-summary-text');
}

function closeTelegramSummary(){
  closeBackdrop(telegramBackdrop);
}

async function copyTelegramSummary(){
  const text = telegramText.value.trim();
  if(!text){ showToast('Сводка пуста.', 'error'); return false; }
  try{
    await navigator.clipboard.writeText(text);
  }catch(err){
    telegramText.focus();
    telegramText.select();
    const copied = document.execCommand('copy');
    telegramText.setSelectionRange(0,0);
    if(!copied) throw err;
  }
  showToast('Сводка скопирована.', 'success');
  return true;
}

document.getElementById('telegram-summary-btn').addEventListener('click', openTelegramSummary);
document.getElementById('telegram-close').addEventListener('click', closeTelegramSummary);
document.getElementById('telegram-cancel').addEventListener('click', closeTelegramSummary);
telegramBackdrop.addEventListener('click', e => { if(e.target === telegramBackdrop) closeTelegramSummary(); });
telegramText.addEventListener('input', updateTelegramCharCount);
document.getElementById('telegram-copy').addEventListener('click', copyTelegramSummary);
document.getElementById('telegram-share').addEventListener('click', async () => {
  const text = telegramText.value.trim();
  if(!text){ showToast('Сводка пуста.', 'error'); return; }
  try{
    if(navigator.share){
      await navigator.share({ title:'Работа по искам об обеспечении доступа', text });
      return;
    }
    const copied = await copyTelegramSummary();
    if(copied) window.open(`https://t.me/share/url?url=&text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  }catch(err){
    if(err?.name !== 'AbortError') reportError('Не удалось открыть меню отправки', err);
  }
});

/* ---------------------------------------------------------------------------
   ЭКСПОРТ
--------------------------------------------------------------------------- */
document.getElementById('export-btn').addEventListener('click', () => {
  try {
    let md = `# Статус по проекту исков — ${formatRuDate(todayLocalIso())}\n\n`;
    GROUP_ORDER.forEach(gid => {
      const cases = CASES.filter(c => (STATUS_DEFS[c.statusKey]||{}).group === gid).sort((a,b)=>a.num-b.num);
      if(!cases.length) return;
      md += `## ${GROUP_TITLES[gid]} (${cases.length})\n`;
      md += `| # | Должник | Л/с | Статус | Примечание | Госпошлина |\n|---|---|---|---|---|---|\n`;
      cases.forEach(c => {
        const def = STATUS_DEFS[c.statusKey] || STATUS_DEFS.draft;
        md += `| ${c.num} | ${escapeMdCell(c.name)} | ${escapeMdCell(c.account||'')} | ${def.icon} ${escapeMdCell(def.label)} | ${escapeMdCell(c.note||'')} | ${c.feeKey==='paid'?'оплачена':'не оплачена'} |\n`;
      });
      md += `\n`;
    });
    if(COURT.length){
      md += `## ⚖️ Судебное производство (${COURT.length})\n`;
      COURT.slice().sort(compareCourtCases).forEach(c => {
        const nh = nearestUpcomingHearingOf(c);
        const preparation = nh?.note ? `, подготовить: ${nh.note}` : '';
        const decisionDate = isCompletedCourtCase(c) ? courtDecisionDateOf(c) : '';
        const outcome = isCompletedCourtCase(c)
          ? `, ${courtOutcomeLabel(c)}${decisionDate ? ', решение от '+formatRuDate(decisionDate) : ', дата решения не указана'}`
          : '';
        md += `- ${DOT[c.dot]||'🔵'} ${escapeMdCell(c.name)} — ${escapeMdCell(c.court||'')}${c.caseNumber?', дело №'+escapeMdCell(c.caseNumber):''}${c.judge?', судья '+escapeMdCell(c.judge):''}${nh?', заседание '+formatRuDateTime(nh.date):''}${escapeMdCell(outcome)}${escapeMdCell(preparation)}\n`;
      });
    }

    // BOM помогает Windows-программам безошибочно распознавать русский UTF-8.
    const blob = new Blob(['\uFEFF', md], { type:'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `статус-${todayLocalIso()}.md`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Экспорт сформирован.', 'success');
  } catch(error) {
    console.error('Ошибка экспорта:', error);
    showToast('Не удалось сформировать экспорт.', 'error');
  }
});

/* ---------------------------------------------------------------------------
   ИМПОРТ (только для администратора) — блок из чата «Учёт статусов»
--------------------------------------------------------------------------- */
const CATEGORY_MAP = {
  'готово':'sent_court', 'отправка':'sent_debtor', 'подписание':'signing', 'на_подписи':'signing', 'ожидание':'waiting_doc',
  'приостановлено':'postponed', 'проблема':'problem',
  'не_требуется':'disconnected', 'не требуется':'disconnected'
};
const FEE_MAP = { 'оплачена':'paid', 'нет_заявки':'unpaid', 'нет заявки':'unpaid', 'не оплачена':'unpaid' };

function parseImportLine(line){
  const parts = line.split('|').map(s => s.trim()).filter(Boolean);
  if(!parts.length) return null;
  const account = parts[0].replace(/\s/g,'');
  let note = '', category = '', fee = '';
  parts.slice(1).forEach(p => {
    const eq = p.indexOf('=');
    if(eq === -1) return;
    const key = p.slice(0, eq).trim().toLowerCase();
    const v = p.slice(eq+1).trim();
    if(key === 'статус') note = v;
    else if(key === 'категория') category = v.toLowerCase();
    else if(key === 'госпошлина') fee = v.toLowerCase();
  });
  return { account, note, statusKey: CATEGORY_MAP[category] || null, feeKey: FEE_MAP[fee] || null };
}

document.getElementById('import-btn').addEventListener('click', () => {
  document.getElementById('import-text').value = '';
  document.getElementById('import-preview').innerHTML = '';
  document.getElementById('import-apply-btn').hidden = true;
  importDiffs = [];
  openBackdrop(document.getElementById('import-backdrop'), '#import-text');
});
function closeImport(){ closeBackdrop(document.getElementById('import-backdrop')); }
document.getElementById('import-close').addEventListener('click', closeImport);
document.getElementById('import-cancel').addEventListener('click', closeImport);
document.getElementById('import-backdrop').addEventListener('click', e => {
  if(e.target.id === 'import-backdrop') closeImport();
});

document.getElementById('import-preview-btn').addEventListener('click', () => {
  const lines = document.getElementById('import-text').value.split('\n').map(l => l.trim()).filter(Boolean);
  importDiffs = [];
  const seenAccounts = new Set();
  const rows = lines.map(line => {
    const parsed = parseImportLine(line);
    if(!parsed) return null;
    if(seenAccounts.has(parsed.account)){
      return { ok:false, text:`Л/с ${escapeHtml(parsed.account)}: повторная строка — пропущена.` };
    }
    seenAccounts.add(parsed.account);
    const existing = CASES.find(c => normalizeAccount(c.account) === parsed.account);
    if(!existing) return { ok:false, text:`Л/с ${escapeHtml(parsed.account)}: должник не найден в реестре — строка пропущена.` };

    const newStatusKey = parsed.statusKey || existing.statusKey;
    const newNote = parsed.note || existing.note || '';
    const newFeeKey = parsed.feeKey || existing.feeKey;
    const changes = [];
    if(newStatusKey !== existing.statusKey) changes.push(`статус: «${escapeHtml((STATUS_DEFS[existing.statusKey]||STATUS_DEFS.draft).label)}» → «${escapeHtml((STATUS_DEFS[newStatusKey]||STATUS_DEFS.draft).label)}»`);
    if(newNote !== (existing.note||'')) changes.push(`примечание: «${escapeHtml(existing.note||'—')}» → «${escapeHtml(newNote||'—')}»`);
    if(newFeeKey !== existing.feeKey) changes.push(`госпошлина: «${existing.feeKey==='paid'?'оплачена':'не оплачена'}» → «${newFeeKey==='paid'?'оплачена':'не оплачена'}»`);
    if(!changes.length) return { ok:false, text:`${escapeHtml(existing.name)}: изменений нет — пропущено.` };

    const before = recordData(existing);
    const after = { ...before, statusKey:newStatusKey, note:newNote, feeKey:newFeeKey };
    importDiffs.push({ id: existing.id, name: existing.name, statusKey:newStatusKey, note:newNote, feeKey:newFeeKey, before, after });
    return { ok:true, text:`<b>${escapeHtml(existing.name)}</b>: ${changes.join('; ')}` };
  }).filter(Boolean);

  document.getElementById('import-preview').innerHTML = rows.length
    ? `<ul style="padding-left:18px;font-size:13.5px;line-height:1.7;margin:12px 0">${rows.map(r => `<li style="color:${r.ok?'var(--ink)':'var(--ink-soft)'}">${r.text}</li>`).join('')}</ul>`
    : '<p style="color:var(--ink-soft)">Не удалось разобрать ни одной строки.</p>';
  document.getElementById('import-apply-btn').hidden = importDiffs.length === 0;
});

document.getElementById('import-apply-btn').addEventListener('click', async e => {
  const n = importDiffs.length;
  if(!n) return;
  await performAction(e.currentTarget, 'Применение…', async () => {
    const items = importDiffs.map(d => ({
      collection:'cases', docId:d.id, label:d.name, before:d.before, after:d.after
    }));
    await commitOperation(batch => {
      importDiffs.forEach(d => {
        batch.update(doc(db, 'cases', d.id), { statusKey:d.statusKey, note:d.note, feeKey:d.feeKey });
      });
    }, {
      text:`Импорт из чата «Учёт статусов»: обновлено дел — ${n}.`,
      action:'import', items
    });
    importDiffs = [];
    closeImport();
    showToast(`Импорт выполнен: обновлено дел — ${n}.`, 'success');
  });
});

/* ---------------------------------------------------------------------------
   УТИЛИТЫ
--------------------------------------------------------------------------- */
class ValidationError extends Error{}

function val(id){ return document.getElementById(id)?.value ?? ''; }
function normalizeAccount(value){ return String(value||'').replace(/\s+/g, ''); }
function normalizeWebUrl(value){
  const text = String(value || '').trim();
  if(!text) return '';
  try{
    const parsed = new URL(text);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  }catch(_err){
    return '';
  }
}
function escapeHtml(s){ const d=document.createElement('div'); d.textContent=s==null?'':String(s); return d.innerHTML; }
function escapeAttr(s){ return escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function escapeMdCell(value){ return String(value??'').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>'); }
function canonicalJson(value){
  if(value === undefined) return 'undefined';
  if(value === null || typeof value !== 'object') return JSON.stringify(value);
  if(Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}
function deepEqual(a,b){ return canonicalJson(a) === canonicalJson(b); }
function formatTimeFromMs(ms){
  const d = new Date(Number(ms));
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
}
function formatShortTimeFromMs(ms){
  const d = new Date(Number(ms));
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' });
}
function formatRuDateTimeFromMs(ms){
  const d = new Date(Number(ms));
  if(Number.isNaN(d.getTime())) return '—';
  return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}, ${formatTimeFromMs(ms)}`;
}
function downloadJson(data, filename){
  const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json;charset=utf-8' });
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function todayLocalIso(){
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth()+1).padStart(2,'0');
  const d = String(now.getDate()).padStart(2,'0');
  return `${y}-${m}-${d}`;
}
function formatRuDate(iso){
  if(!iso) return '—';
  const [y,m,d] = iso.split('-');
  return y && m && d ? `${d}.${m}.${y}` : iso;
}
function formatRuDateTime(iso){
  if(!iso) return '—';
  const [datePart, timePart] = iso.split('T');
  return formatRuDate(datePart) + (timePart ? ', ' + timePart.slice(0,5) : '');
}

function setConnectionStatus(state, text){
  const el = document.getElementById('conn-status');
  if(!el) return;
  el.textContent = text;
  el.classList.toggle('offline', state === 'offline');
  el.classList.toggle('connecting', state === 'connecting');
}

window.addEventListener('offline', () => setConnectionStatus('offline', '● нет сети'));
window.addEventListener('online', () => {
  setConnectionStatus(
    Object.values(listenerReady).every(Boolean) ? 'online' : 'connecting',
    Object.values(listenerReady).every(Boolean) ? '● подключено' : '● восстановление подключения…'
  );
});

function showToast(message, type='success'){
  const region = document.getElementById('toast-region');
  if(!region) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  region.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 180);
  }, type === 'error' ? 5000 : 3000);
}

function reportError(context, err, notify=true){
  console.error(context, err);
  if(notify) showToast(`${context}. Повторите попытку.`, 'error');
}

function markInvalid(id, message){
  const el = document.getElementById(id);
  if(el){
    el.classList.add('is-invalid');
    el.focus();
  }
  showToast(message, 'error');
}

async function performAction(button, busyText, action){
  if(button?.disabled) return false;
  const originalText = button?.textContent;
  if(button){
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = busyText;
  }
  try{
    await action();
    return true;
  }catch(err){
    if(!(err instanceof ValidationError)) reportError('Не удалось выполнить операцию', err);
    return false;
  }finally{
    if(button){
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = originalText;
    }
  }
}

document.addEventListener('keydown', e => {
  if(e.key !== 'Escape') return;
  const telegramBackdrop = document.getElementById('telegram-backdrop');
  if(telegramBackdrop?.classList.contains('open')) closeTelegramSummary();
  else if(courtUpdateBackdrop?.classList.contains('open')) closeCourtUpdate();
  else if(document.getElementById('import-backdrop').classList.contains('open')) closeImport();
  else if(backdrop.classList.contains('open')){
    showToast('Закройте карточку кнопкой «Сохранить» или «Отмена».', 'info');
  }
});
