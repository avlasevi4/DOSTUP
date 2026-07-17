import { firebaseConfig, ADMIN_CODE, STAFF_CODE } from './firebase-config.js';
import { SEED_CASES, SEED_COURT_CASES, SEED_LOG } from './seed-data.js';

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getFirestore, collection, doc, getDocs, addDoc, updateDoc,
  deleteDoc, onSnapshot, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

/* ---------------------------------------------------------------------------
   FIREBASE (объявления — до блока ДОСТУП, т.к. boot() может вызваться сразу)
--------------------------------------------------------------------------- */
let db;
let CASES = [];       // локальный кэш дел (живёт из onSnapshot)
let COURT = [];
let LOGS = [];
let modalHearings = [];   // временный список заседаний, пока открыта карточка судопроизводства
let importDiffs = [];     // изменения, посчитанные при предпросмотре импорта

/* ---------------------------------------------------------------------------
   ФИКСИРОВАННЫЕ СТАТУСЫ (значок и группа подставляются автоматически)
--------------------------------------------------------------------------- */
const STATUS_DEFS = {
  sent_court:   { label:'Направлено в суд',                         icon:'✅', badge:'done',     group:'A' },
  sent_debtor:  { label:'Направлено ответчику, ждём реестр',        icon:'📮', badge:'progress', group:'A' },
  draft:        { label:'Черновик готовится',                      icon:'🟡', badge:'wait',     group:'B' },
  waiting_doc:  { label:'Ждём документ (третьи лица)',              icon:'⏸', badge:'wait',     group:'B' },
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

function boot(){
  if(firebaseConfig.apiKey === 'ВСТАВЬТЕ_СЮДА'){
    document.getElementById('groups').innerHTML =
      `<div style="padding:40px;text-align:center;color:var(--stamp-red)">
         Firebase не настроен. Откройте <code>firebase-config.js</code> и вставьте
         данные вашего проекта — инструкция в README.md.
       </div>`;
    return;
  }

  const fbApp = initializeApp(firebaseConfig);
  db = getFirestore(fbApp);

  seedIfEmpty()
    .then(migrateLegacyCases)
    .then(migrateLegacyCourt)
    .then(() => {
      listenCases();
      listenCourt();
      listenLogs();
    });

  document.getElementById('conn-status').textContent = '● подключено';
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

function listenCases(){
  onSnapshot(collection(db, 'cases'), snap => {
    CASES = snap.docs.map(d => ({ id:d.id, ...d.data() }));
    renderGroups();
    renderSummary();
    document.getElementById('stamp-total').textContent = CASES.length || 18;
  }, err => {
    document.getElementById('conn-status').textContent = '● офлайн / ошибка подключения';
    document.getElementById('conn-status').classList.add('offline');
    console.error(err);
  });
}
function listenCourt(){
  onSnapshot(collection(db, 'courtCases'), snap => {
    COURT = snap.docs.map(d => ({ id:d.id, ...d.data() }));
    renderCourt();
    renderCourtSummary();
    renderSummary();
  });
}
function listenLogs(){
  onSnapshot(collection(db, 'logs'), snap => {
    LOGS = snap.docs.map(d => ({ id:d.id, ...d.data() }))
      .sort((a,b) => (b.date||'').localeCompare(a.date||''));
    renderLog();
    if(LOGS[0]) document.getElementById('last-updated').textContent = 'обновлено ' + formatRuDate(LOGS[0].date);
  });
}

async function addLog(text){
  await addDoc(collection(db, 'logs'), { date: new Date().toISOString().slice(0,10), text });
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
      const row = document.createElement('div');
      row.className = 'case-row';
      row.innerHTML = `
        <div class="case-num">${String(c.num).padStart(2,'0')}</div>
        <div>
          <div class="case-name">${escapeHtml(c.name)}</div>
          <div class="case-account">л/с ${escapeHtml(c.account || '—')}</div>
        </div>
        <div class="case-status"><span class="badge badge-${def.badge}">${def.icon} ${escapeHtml(def.label)}${c.note ? ' — ' + escapeHtml(c.note) : ''}</span></div>
        <div class="case-fee">💳 ${c.feeKey === 'paid' ? 'оплачена' : 'не оплачена'}</div>
        <div class="case-edit-icon">✎</div>
      `;
      row.addEventListener('click', () => openCaseModal(c));
      group.appendChild(row);
    });
    el.appendChild(group);
  });
}

const SUMMARY_CHIP_DEFS = [
  { key:'sent_court',  label:'Готово/направлено' },
  { key:'sent_debtor', label:'Отправка' },
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

function nearestHearingOf(c){
  const now = new Date();
  const upcoming = (c.hearings||[]).filter(h => h.date && new Date(h.date) >= now)
    .sort((a,b) => new Date(a.date) - new Date(b.date));
  if(upcoming.length) return upcoming[0];
  const past = (c.hearings||[]).filter(h => h.date).sort((a,b) => new Date(b.date) - new Date(a.date));
  return past[0] || null;
}

function renderCourt(){
  const el = document.getElementById('court-list');
  if(COURT.length === 0){
    el.innerHTML = `<p style="color:var(--ink-soft)">Пока нет дел в судебном производстве — появятся здесь, как только иск будет направлен в суд.</p>`;
    return;
  }
  el.innerHTML = '';
  COURT.forEach(c => {
    const card = document.createElement('div');
    card.className = 'court-card';
    const nh = nearestHearingOf(c);
    const hearingText = nh ? formatRuDateTime(nh.date) : 'не назначено';
    card.innerHTML = `
      <div class="court-dot">${DOT[c.dot]||'🔵'}</div>
      <div>
        <div class="court-name">${escapeHtml(c.name)}</div>
        <div class="court-meta">${escapeHtml(c.court || '—')}${c.caseNumber ? ' · дело №'+escapeHtml(c.caseNumber) : ''}${c.filedDate ? ' · подан '+formatRuDate(c.filedDate) : ''}</div>
        ${c.notes ? `<div class="court-meta" style="margin-top:6px">${escapeHtml(c.notes)}</div>` : ''}
      </div>
      <div class="court-hearing"><b>${hearingText}</b>${c.judge ? '<br>Судья: '+escapeHtml(c.judge) : ''}</div>
    `;
    card.addEventListener('click', () => openCourtModal(c));
    el.appendChild(card);
  });
}

function renderCourtSummary(){
  const el = document.getElementById('court-summary-strip');
  if(!el) return;
  const now = new Date();
  let nearest = null;
  COURT.forEach(c => {
    (c.hearings||[]).forEach(h => {
      if(!h.date) return;
      const dt = new Date(h.date);
      if(dt >= now && (!nearest || dt < nearest.dt)) nearest = { dt, name:c.name, id:c.id, dateStr:h.date };
    });
  });
  const weekAhead = new Date(now.getTime() + 7*24*3600*1000);
  let weekCount = 0;
  COURT.forEach(c => (c.hearings||[]).forEach(h => {
    if(!h.date) return;
    const dt = new Date(h.date);
    if(dt >= now && dt <= weekAhead) weekCount++;
  }));
  const chips = [];
  chips.push(nearest
    ? `<div class="summary-chip chip-link" onclick="window.openCourtCardById('${nearest.id}')">⏰ Ближайшее: <b>${formatRuDateTime(nearest.dateStr)}</b> — ${escapeHtml(nearest.name)}</div>`
    : `<div class="summary-chip">⏰ Ближайшее заседание: <b>нет назначенных</b></div>`);
  chips.push(`<div class="summary-chip">⚖️ Всего в производстве: <b>${COURT.length}</b></div>`);
  chips.push(`<div class="summary-chip">📅 Заседаний за 7 дней: <b>${weekCount}</b></div>`);
  el.innerHTML = chips.join('');
}
window.openCourtCardById = function(id){
  const c = COURT.find(x => x.id === id);
  if(c) openCourtModal(c);
};

/* ---------------------------------------------------------------------------
   РЕНДЕР: ЖУРНАЛ
--------------------------------------------------------------------------- */
function renderLog(){
  const el = document.getElementById('log-list');
  el.innerHTML = LOGS.map(l => `
    <li><span class="log-date">${formatRuDate(l.date)}</span>${escapeHtml(l.text)}</li>
  `).join('') || '<p style="color:var(--ink-soft)">Журнал пуст.</p>';
}

/* ---------------------------------------------------------------------------
   МОДАЛЬНОЕ ОКНО: КАРТОЧКА ДЕЛА / СУДОПРОИЗВОДСТВА
--------------------------------------------------------------------------- */
const backdrop = document.getElementById('modal-backdrop');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');
const modalDelete = document.getElementById('modal-delete');

let activeRecord = null;   // {kind:'case'|'newcase'|'court', data:{...}}

function closeModal(){ backdrop.classList.remove('open'); activeRecord = null; modalHearings = []; }
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-cancel').addEventListener('click', closeModal);
backdrop.addEventListener('click', e => { if(e.target === backdrop) closeModal(); });

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
  backdrop.classList.add('open');
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
  backdrop.classList.add('open');
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

function openCourtModal(c){
  activeRecord = { kind:'court', data:c };
  modalHearings = JSON.parse(JSON.stringify(c.hearings || (c.hearingDate ? [{date:c.hearingDate, note:''}] : [])));
  const isNew = !c.id;
  modalTitle.textContent = isNew ? 'Новое дело в производстве' : `Судебное дело · ${c.name}`;
  modalDelete.hidden = isNew;

  const knownCourts = [...new Set(COURT.map(x => x.court).filter(Boolean))].sort();
  const currentCourtVal = c.court && knownCourts.includes(c.court) ? c.court : (c.court ? '__other__' : '');

  const debtorField = isNew
    ? `<div class="field"><label>Должник</label><select id="f-caseSelect">
        ${CASES.slice().sort((a,b)=>a.num-b.num).map(cc =>
          `<option value="${escapeHtml(cc.account)}" data-name="${escapeHtml(cc.name)}">${String(cc.num).padStart(2,'0')}. ${escapeHtml(cc.name)}</option>`
        ).join('')}
      </select></div>`
    : `<div class="field"><label>Должник</label><div class="readonly-text">${escapeHtml(c.name)} (л/с ${escapeHtml(c.account||'—')})</div></div>`;

  modalBody.innerHTML = `
    ${debtorField}
    <div class="field-row">
      <div class="field"><label>Суд</label>
        <select id="f-court-select">
          <option value="">— выбрать —</option>
          ${knownCourts.map(cv => `<option value="${escapeHtml(cv)}" ${cv===currentCourtVal?'selected':''}>${escapeHtml(cv)}</option>`).join('')}
          <option value="__other__" ${currentCourtVal==='__other__'?'selected':''}>Другое (указать)</option>
        </select>
        <input id="f-court-other" placeholder="Название суда" style="margin-top:6px;${currentCourtVal==='__other__'?'':'display:none'}" value="${currentCourtVal==='__other__'?escapeHtml(c.court||''):''}">
      </div>
      <div class="field"><label>Номер дела</label><input id="f-caseNumber" value="${escapeHtml(c.caseNumber||'')}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Дата подачи</label><input type="date" id="f-filedDate" value="${c.filedDate||''}"></div>
      <div class="field"><label>Судья</label><input id="f-judge" value="${escapeHtml(c.judge||'')}" placeholder="Фамилия И.О."></div>
    </div>
    <div class="field"><label>Статус производства</label>
      <select id="f-dot">
        <option value="blue" ${c.dot==='blue'?'selected':''}>🔵 В процессе</option>
        <option value="done" ${c.dot==='done'?'selected':''}>✅ Удовлетворено</option>
        <option value="denied" ${c.dot==='denied'?'selected':''}>❌ Отказано</option>
        <option value="partial" ${c.dot==='partial'?'selected':''}>🟠 Частично</option>
      </select>
    </div>
    <div class="field">
      <label>Заседания</label>
      <div id="hearings-list"></div>
      <div class="hearing-add-row">
        <input type="datetime-local" id="f-newHearingDate">
        <input id="f-newHearingNote" placeholder="Что подготовить к заседанию">
        <button type="button" id="btn-add-hearing" class="btn-ghost">+ Добавить заседание</button>
      </div>
    </div>
    <div class="field"><label>Заметки</label><textarea id="f-notes">${escapeHtml(c.notes||'')}</textarea></div>
  `;
  renderHearingsList();

  document.getElementById('btn-add-hearing').addEventListener('click', () => {
    const dv = document.getElementById('f-newHearingDate').value;
    const nv = document.getElementById('f-newHearingNote').value;
    if(!dv){ alert('Укажите дату заседания'); return; }
    modalHearings.push({ date: dv, note: nv });
    document.getElementById('f-newHearingDate').value = '';
    document.getElementById('f-newHearingNote').value = '';
    renderHearingsList();
  });

  const courtSelect = document.getElementById('f-court-select');
  courtSelect.addEventListener('change', () => {
    document.getElementById('f-court-other').style.display = courtSelect.value === '__other__' ? 'block' : 'none';
  });

  backdrop.classList.add('open');
}
document.getElementById('add-court-btn').addEventListener('click', () => openCourtModal({}));

document.getElementById('modal-save').addEventListener('click', async () => {
  if(!activeRecord) return;

  if(activeRecord.kind === 'case'){
    const c = activeRecord.data;
    const statusKey = val('f-statusKey');
    await updateDoc(doc(db, 'cases', c.id), { statusKey, note: val('f-note'), feeKey: val('f-feeKey') });
    await addLog(`${c.name}: статус обновлён — «${STATUS_DEFS[statusKey].label}».`);

  } else if(activeRecord.kind === 'newcase'){
    const name = val('f-name').trim();
    const account = val('f-account').trim();
    if(!name || !account){ alert('Укажите ФИО и лицевой счёт.'); return; }
    const num = CASES.reduce((max, c) => Math.max(max, c.num||0), 0) + 1;
    await addDoc(collection(db, 'cases'), {
      num, name, account, address: val('f-address').trim(),
      statusKey: val('f-statusKey'), note: val('f-note'), feeKey: val('f-feeKey'), protected: false
    });
    await addLog(`${name}: добавлен новый должник в реестр (№${num}).`);

  } else {
    const c = activeRecord.data;
    const isNew = !c.id;
    const courtSelectVal = val('f-court-select');
    const finalCourt = courtSelectVal === '__other__' ? val('f-court-other') : courtSelectVal;
    let name = c.name, account = c.account;
    if(isNew){
      const sel = document.getElementById('f-caseSelect');
      account = sel.value;
      name = sel.selectedOptions[0] ? sel.selectedOptions[0].dataset.name : '';
    }
    const updated = {
      name, account,
      court: finalCourt, caseNumber: val('f-caseNumber'),
      filedDate: val('f-filedDate'), judge: val('f-judge'),
      dot: val('f-dot'), notes: val('f-notes'),
      hearings: modalHearings.slice().sort((a,b) => new Date(a.date) - new Date(b.date))
    };
    if(!isNew){
      await updateDoc(doc(db, 'courtCases', c.id), updated);
      await addLog(`${updated.name}: обновлена карточка судебного производства.`);
    } else {
      await addDoc(collection(db, 'courtCases'), updated);
      await addLog(`${updated.name}: заведено дело в судебном производстве (${updated.court || 'суд не указан'}).`);
    }
  }
  closeModal();
});

modalDelete.addEventListener('click', async () => {
  if(!activeRecord || !activeRecord.data.id) return;
  if(activeRecord.kind === 'case' && activeRecord.data.protected) return;
  if(!confirm('Удалить эту запись? Действие необратимо.')) return;
  const coll = activeRecord.kind === 'case' ? 'cases' : 'courtCases';
  await deleteDoc(doc(db, coll, activeRecord.data.id));
  await addLog(`Запись «${activeRecord.data.name}» удалена.`);
  closeModal();
});

function val(id){ return document.getElementById(id).value; }

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

/* ---------------------------------------------------------------------------
   ЗАМЕТКА / ЭКСПОРТ
--------------------------------------------------------------------------- */
document.getElementById('add-note-btn').addEventListener('click', async () => {
  const text = prompt('Текст заметки для журнала:');
  if(text) await addLog(text);
});

document.getElementById('export-btn').addEventListener('click', () => {
  let md = `# Статус по проекту исков — ${formatRuDate(new Date().toISOString().slice(0,10))}\n\n`;
  GROUP_ORDER.forEach(gid => {
    const cases = CASES.filter(c => (STATUS_DEFS[c.statusKey]||{}).group === gid).sort((a,b)=>a.num-b.num);
    if(!cases.length) return;
    md += `## ${GROUP_TITLES[gid]} (${cases.length})\n`;
    md += `| # | Должник | Л/с | Статус | Примечание | Госпошлина |\n|---|---|---|---|---|---|\n`;
    cases.forEach(c => {
      const def = STATUS_DEFS[c.statusKey] || STATUS_DEFS.draft;
      md += `| ${c.num} | ${c.name} | ${c.account||''} | ${def.icon} ${def.label} | ${c.note||''} | ${c.feeKey==='paid'?'оплачена':'не оплачена'} |\n`;
    });
    md += `\n`;
  });
  if(COURT.length){
    md += `## ⚖️ Судебное производство (${COURT.length})\n`;
    COURT.forEach(c => {
      const nh = nearestHearingOf(c);
      md += `- ${DOT[c.dot]||'🔵'} ${c.name} — ${c.court}${c.caseNumber?', дело №'+c.caseNumber:''}${c.judge?', судья '+c.judge:''}${nh?', заседание '+formatRuDateTime(nh.date):''}\n`;
    });
  }
  const blob = new Blob([md], { type:'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `статус-${new Date().toISOString().slice(0,10)}.md`;
  a.click();
});

/* ---------------------------------------------------------------------------
   ИМПОРТ (только для администратора) — блок из чата «Учёт статусов»
--------------------------------------------------------------------------- */
const CATEGORY_MAP = {
  'готово':'sent_court', 'отправка':'sent_debtor', 'ожидание':'waiting_doc',
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
  document.getElementById('import-backdrop').classList.add('open');
});
function closeImport(){ document.getElementById('import-backdrop').classList.remove('open'); }
document.getElementById('import-close').addEventListener('click', closeImport);
document.getElementById('import-cancel').addEventListener('click', closeImport);
document.getElementById('import-backdrop').addEventListener('click', e => {
  if(e.target.id === 'import-backdrop') closeImport();
});

document.getElementById('import-preview-btn').addEventListener('click', () => {
  const lines = document.getElementById('import-text').value.split('\n').map(l => l.trim()).filter(Boolean);
  importDiffs = [];
  const rows = lines.map(line => {
    const parsed = parseImportLine(line);
    if(!parsed) return null;
    const existing = CASES.find(c => c.account === parsed.account);
    if(!existing) return { ok:false, text:`Л/с ${escapeHtml(parsed.account)}: должник не найден в реестре — строка пропущена.` };

    const newStatusKey = parsed.statusKey || existing.statusKey;
    const newNote = parsed.note || existing.note || '';
    const newFeeKey = parsed.feeKey || existing.feeKey;
    const changes = [];
    if(newStatusKey !== existing.statusKey) changes.push(`статус: «${STATUS_DEFS[existing.statusKey].label}» → «${STATUS_DEFS[newStatusKey].label}»`);
    if(newNote !== (existing.note||'')) changes.push(`примечание: «${existing.note||'—'}» → «${newNote||'—'}»`);
    if(newFeeKey !== existing.feeKey) changes.push(`госпошлина: «${existing.feeKey==='paid'?'оплачена':'не оплачена'}» → «${newFeeKey==='paid'?'оплачена':'не оплачена'}»`);
    if(!changes.length) return { ok:false, text:`${escapeHtml(existing.name)}: изменений нет — пропущено.` };

    importDiffs.push({ id: existing.id, name: existing.name, statusKey:newStatusKey, note:newNote, feeKey:newFeeKey });
    return { ok:true, text:`<b>${escapeHtml(existing.name)}</b>: ${changes.join('; ')}` };
  }).filter(Boolean);

  document.getElementById('import-preview').innerHTML = rows.length
    ? `<ul style="padding-left:18px;font-size:13.5px;line-height:1.7;margin:12px 0">${rows.map(r => `<li style="color:${r.ok?'var(--ink)':'var(--ink-soft)'}">${r.text}</li>`).join('')}</ul>`
    : '<p style="color:var(--ink-soft)">Не удалось разобрать ни одной строки.</p>';
  document.getElementById('import-apply-btn').hidden = importDiffs.length === 0;
});

document.getElementById('import-apply-btn').addEventListener('click', async () => {
  const n = importDiffs.length;
  for(const d of importDiffs){
    await updateDoc(doc(db, 'cases', d.id), { statusKey:d.statusKey, note:d.note, feeKey:d.feeKey });
  }
  await addLog(`Импорт из чата «Учёт статусов»: обновлено дел — ${n}.`);
  importDiffs = [];
  closeImport();
});

/* ---------------------------------------------------------------------------
   УТИЛИТЫ
--------------------------------------------------------------------------- */
function escapeHtml(s){ const d=document.createElement('div'); d.textContent=s==null?'':String(s); return d.innerHTML; }
function formatRuDate(iso){
  if(!iso) return '—';
  const [y,m,d] = iso.split('-');
  return `${d}.${m}.${y}`;
}
function formatRuDateTime(iso){
  if(!iso) return '—';
  const [datePart, timePart] = iso.split('T');
  return formatRuDate(datePart) + (timePart ? ', ' + timePart : '');
}
