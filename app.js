import { firebaseConfig, ACCESS_CODE } from './firebase-config.js';
import { SEED_GROUPS, SEED_COURT_CASES, SEED_LOG } from './seed-data.js';

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getFirestore, collection, doc, getDocs, setDoc, addDoc, updateDoc,
  deleteDoc, onSnapshot, query, orderBy, writeBatch, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

/* ---------------------------------------------------------------------------
   ДОСТУП (простой код, не полноценная авторизация — см. firebase-config.js)
--------------------------------------------------------------------------- */
const gate = document.getElementById('gate');
const app = document.getElementById('app');
const gateInput = document.getElementById('gate-input');
const gateError = document.getElementById('gate-error');

function tryUnlock(){
  if(gateInput.value === ACCESS_CODE){
    sessionStorage.setItem('gmi-unlocked', '1');
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
  gate.hidden = true;
  app.hidden = false;
  boot();
}

/* ---------------------------------------------------------------------------
   FIREBASE
--------------------------------------------------------------------------- */
let db;
let CASES = [];       // локальный кэш дел (живёт из onSnapshot)
let COURT = [];
let LOGS = [];

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

  seedIfEmpty().then(() => {
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
  SEED_GROUPS.forEach(group => {
    group.cases.forEach(c => {
      const ref = doc(collection(db, 'cases'));
      batch.set(ref, { ...c, groupId: group.id, groupTitle: group.title });
    });
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

function listenCases(){
  onSnapshot(collection(db, 'cases'), snap => {
    CASES = snap.docs.map(d => ({ id:d.id, ...d.data() }));
    renderGroups();
    renderSummary();
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
    document.getElementById('stamp-total').textContent = CASES.length || 18;
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
const GROUP_ORDER = ['A','B','V','G'];
const GROUP_TITLES = {
  A:'Группа А. Готово / на стадии подачи',
  B:'Группа Б. Ждём документ (акт/уведомление)',
  V:'Группа В. Приостановлено / риски',
  G:'Группа Г. Не требуется'
};
const BADGE_CLASS = { done:'badge-done', problem:'badge-problem', wait:'badge-wait', progress:'badge-progress', none:'badge-none' };

function renderGroups(){
  const el = document.getElementById('groups');
  el.innerHTML = '';
  GROUP_ORDER.forEach(gid => {
    const cases = CASES.filter(c => c.groupId === gid).sort((a,b) => a.num - b.num);
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
      const row = document.createElement('div');
      row.className = 'case-row';
      row.innerHTML = `
        <div class="case-num">${String(c.num).padStart(2,'0')}</div>
        <div>
          <div class="case-name">${c.name}</div>
          <div class="case-account">л/с ${c.account || '—'}</div>
        </div>
        <div class="case-status"><span class="badge ${BADGE_CLASS[c.badge]||'badge-none'}">${c.icon||''} ${escapeHtml(c.status||'')}</span></div>
        <div class="case-fee">💳 ${c.fee||'—'}</div>
        <div class="case-edit-icon">✎</div>
      `;
      row.addEventListener('click', () => openCaseModal(c));
      group.appendChild(row);
    });
    el.appendChild(group);
  });
}

function renderSummary(){
  const strip = document.getElementById('summary-strip');
  const counts = {};
  CASES.forEach(c => { counts[c.badge] = (counts[c.badge]||0) + 1; });
  const labels = { done:'✅ Готово/направлено', problem:'🔴 Проблема', wait:'⏳ Ожидание', progress:'📮 В процессе', none:'⚪ Не требуется' };
  strip.innerHTML = Object.entries(labels).map(([key,label]) =>
    counts[key] ? `<div class="summary-chip">${label}: <b>${counts[key]}</b></div>` : ''
  ).join('') + `<div class="summary-chip">Всего дел: <b>${CASES.length}</b></div>`;
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
    const hearing = c.hearingDate ? formatRuDateTime(c.hearingDate) : 'не назначено';
    card.innerHTML = `
      <div class="court-dot">${DOT[c.dot]||'🔵'}</div>
      <div>
        <div class="court-name">${c.name}</div>
        <div class="court-meta">${c.court || '—'}${c.caseNumber ? ' · дело №'+c.caseNumber : ''}${c.filedDate ? ' · подан '+formatRuDate(c.filedDate) : ''}</div>
        ${c.notes ? `<div class="court-meta" style="margin-top:6px">${escapeHtml(c.notes)}</div>` : ''}
      </div>
      <div class="court-hearing"><b>${hearing}</b>${c.hearingRoom ? '<br>'+c.hearingRoom : ''}</div>
    `;
    card.addEventListener('click', () => openCourtModal(c));
    el.appendChild(card);
  });
}

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
   МОДАЛЬНОЕ ОКНО: КАРТОЧКА ДЕЛА
--------------------------------------------------------------------------- */
const backdrop = document.getElementById('modal-backdrop');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');
const modalDelete = document.getElementById('modal-delete');

let activeRecord = null;   // {kind:'case'|'court', data:{...}}

function closeModal(){ backdrop.hidden = true; activeRecord = null; }
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-cancel').addEventListener('click', closeModal);
backdrop.addEventListener('click', e => { if(e.target === backdrop) closeModal(); });

function openCaseModal(c){
  activeRecord = { kind:'case', data:c };
  modalTitle.textContent = `№${c.num} · ${c.name}`;
  modalDelete.hidden = true;
  modalBody.innerHTML = `
    <div class="field"><label>Лицевой счёт</label><input id="f-account" value="${c.account||''}"></div>
    <div class="field-row">
      <div class="field"><label>Значок статуса</label>
        <select id="f-icon">
          ${['✅','⏸','📮','🟡','🔴','🚫','⚪'].map(i=>`<option ${i===c.icon?'selected':''}>${i}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Категория (цвет)</label>
        <select id="f-badge">
          <option value="done" ${c.badge==='done'?'selected':''}>Готово / зелёный</option>
          <option value="progress" ${c.badge==='progress'?'selected':''}>В процессе / синий</option>
          <option value="wait" ${c.badge==='wait'?'selected':''}>Ожидание / жёлтый</option>
          <option value="problem" ${c.badge==='problem'?'selected':''}>Проблема / красный</option>
          <option value="none" ${c.badge==='none'?'selected':''}>Не требуется / серый</option>
        </select>
      </div>
    </div>
    <div class="field"><label>Статус (текст)</label><textarea id="f-status">${c.status||''}</textarea></div>
    <div class="field-row">
      <div class="field"><label>Госпошлина</label><input id="f-fee" value="${c.fee||''}"></div>
      <div class="field"><label>Группа</label>
        <select id="f-group">
          ${GROUP_ORDER.map(g=>`<option value="${g}" ${g===c.groupId?'selected':''}>${GROUP_TITLES[g]}</option>`).join('')}
        </select>
      </div>
    </div>
  `;
  backdrop.hidden = false;
}

function openCourtModal(c){
  activeRecord = { kind:'court', data:c };
  modalTitle.textContent = c.id ? `Судебное дело · ${c.name}` : 'Новое дело в производстве';
  modalDelete.hidden = !c.id;
  modalBody.innerHTML = `
    <div class="field"><label>ФИО должника</label><input id="f-name" value="${c.name||''}"></div>
    <div class="field-row">
      <div class="field"><label>Суд</label><input id="f-court" value="${c.court||''}"></div>
      <div class="field"><label>Номер дела</label><input id="f-caseNumber" value="${c.caseNumber||''}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Дата подачи</label><input type="date" id="f-filedDate" value="${c.filedDate||''}"></div>
      <div class="field"><label>Заседание</label><input type="datetime-local" id="f-hearingDate" value="${c.hearingDate||''}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Зал</label><input id="f-hearingRoom" value="${c.hearingRoom||''}"></div>
      <div class="field"><label>Статус</label>
        <select id="f-dot">
          <option value="blue" ${c.dot==='blue'?'selected':''}>🔵 В процессе</option>
          <option value="done" ${c.dot==='done'?'selected':''}>✅ Удовлетворено</option>
          <option value="denied" ${c.dot==='denied'?'selected':''}>❌ Отказано</option>
          <option value="partial" ${c.dot==='partial'?'selected':''}>🟠 Частично</option>
        </select>
      </div>
    </div>
    <div class="field"><label>Заметки</label><textarea id="f-notes">${c.notes||''}</textarea></div>
  `;
  backdrop.hidden = false;
}

document.getElementById('add-court-btn').addEventListener('click', () => openCourtModal({}));

document.getElementById('modal-save').addEventListener('click', async () => {
  if(!activeRecord) return;
  if(activeRecord.kind === 'case'){
    const c = activeRecord.data;
    const updated = {
      account: val('f-account'), icon: val('f-icon'), badge: val('f-badge'),
      status: val('f-status'), fee: val('f-fee'), groupId: val('f-group'),
      groupTitle: GROUP_TITLES[val('f-group')]
    };
    await updateDoc(doc(db, 'cases', c.id), updated);
    await addLog(`${c.name}: статус обновлён — «${updated.status}».`);
  } else {
    const c = activeRecord.data;
    const updated = {
      name: val('f-name'), court: val('f-court'), caseNumber: val('f-caseNumber'),
      filedDate: val('f-filedDate'), hearingDate: val('f-hearingDate'),
      hearingRoom: val('f-hearingRoom'), dot: val('f-dot'), notes: val('f-notes')
    };
    if(c.id){
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
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

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
    const cases = CASES.filter(c => c.groupId === gid).sort((a,b)=>a.num-b.num);
    if(!cases.length) return;
    md += `## ${GROUP_TITLES[gid]} (${cases.length})\n`;
    md += `| # | Должник | Статус | Госпошлина |\n|---|---|---|---|\n`;
    cases.forEach(c => { md += `| ${c.num} | ${c.name} | ${c.icon} ${c.status} | 💳 ${c.fee} |\n`; });
    md += `\n`;
  });
  if(COURT.length){
    md += `## ⚖️ Судебное производство (${COURT.length})\n`;
    COURT.forEach(c => {
      md += `- ${DOT[c.dot]||'🔵'} ${c.name} — ${c.court}${c.caseNumber?', дело №'+c.caseNumber:''}${c.hearingDate?', заседание '+formatRuDateTime(c.hearingDate):''}\n`;
    });
  }
  const blob = new Blob([md], { type:'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `статус-${new Date().toISOString().slice(0,10)}.md`;
  a.click();
});

/* ---------------------------------------------------------------------------
   УТИЛИТЫ
--------------------------------------------------------------------------- */
function escapeHtml(s){ const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
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
