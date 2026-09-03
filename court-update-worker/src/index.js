const ALLOWED_ORIGIN = 'https://avlasevi4.github.io';
const MAX_CASES_PER_REQUEST = 12;
const FETCH_TIMEOUT_MS = 25000;
const AUTO_UPDATE_DOCUMENT = 'systemSettings/courtAutoUpdate';

function headersFor(request){
  const origin = request.headers.get('Origin');
  return {
    'access-control-allow-origin': origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'vary': 'Origin'
  };
}

function json(request, body, status=200){
  return new Response(JSON.stringify(body), { status, headers:headersFor(request) });
}

function isCourtPageUrl(value){
  try{
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === 'https:'
      && !url.port
      && hostname.endsWith('.sudrf.ru')
      && hostname !== 'sudrf.ru';
  }catch(_err){
    return false;
  }
}

function htmlText(value){
  const entities = {
    '&nbsp;':' ', '&amp;':'&', '&quot;':'"', '&#39;':"'", '&lt;':'<', '&gt;':'>'
  };
  return String(value || '')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(nbsp|amp|quot|lt|gt);|&#39;/gi, match => entities[match.toLowerCase()] || ' ')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function moscowToday(){
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone:'Europe/Moscow', year:'numeric', month:'2-digit', day:'2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function toIsoDateTime(dateText, timeText){
  const date = String(dateText || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  const time = String(timeText || '').match(/^(\d{1,2}):(\d{2})$/);
  if(!date || !time) return '';
  const day = Number(date[1]);
  const month = Number(date[2]);
  const year = Number(date[3]);
  const hour = Number(time[1]);
  const minute = Number(time[2]);
  if(month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function mainCaseNumber(value){
  return String(value || '').split(/[~∼〜～]/, 1)[0].trim();
}

function normalizedHearings(hearings){
  const seen = new Set();
  return (Array.isArray(hearings) ? hearings : [])
    .map(hearing => ({ date:String(hearing?.date || '').trim(), note:String(hearing?.note || '').trim() }))
    .filter(hearing => /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?$/.test(hearing.date))
    .sort((a,b) => a.date.localeCompare(b.date))
    .filter(hearing => {
      if(seen.has(hearing.date)) return false;
      seen.add(hearing.date);
      return true;
    });
}

function deepEqual(left, right){
  return JSON.stringify(left) === JSON.stringify(right);
}

function isInactiveCourtCase(caseData){
  return ['paused', 'terminated', 'done', 'denied', 'partial'].includes(String(caseData?.dot || ''));
}

function hearingDiff(caseData, fetched={}){
  const beforeHearings = normalizedHearings(caseData.hearings);
  const today = moscowToday();
  const pastHearings = beforeHearings.filter(hearing => hearing.date.slice(0, 10) < today);
  const currentHearings = beforeHearings.filter(hearing => hearing.date.slice(0, 10) >= today);
  const sourceHearings = normalizedHearings(fetched.hearings);
  const currentByDate = new Map(currentHearings.map(hearing => [hearing.date, hearing]));
  const canTransferNotes = sourceHearings.length === currentHearings.length;
  const afterCurrentHearings = sourceHearings.map((hearing, index) => {
    const exact = currentByDate.get(hearing.date);
    const transferredNote = canTransferNotes ? currentHearings[index]?.note : '';
    return { date:hearing.date, note:exact?.note || transferredNote || '' };
  });
  const afterHearings = normalizedHearings([...pastHearings, ...afterCurrentHearings]);
  const sourceDates = new Set(sourceHearings.map(hearing => hearing.date));
  const currentDates = new Set(currentHearings.map(hearing => hearing.date));
  const patch = deepEqual(beforeHearings, afterHearings) ? {} : { hearings:afterHearings };
  return {
    id:caseData.id, name:caseData.name || '', court:caseData.court || '', kind:'hearings',
    beforeHearings, afterHearings,
    beforeCaseNumber:String(caseData.caseNumber || '').trim(),
    beforeJudge:String(caseData.judge || '').trim(),
    added:afterCurrentHearings.filter(hearing => !currentDates.has(hearing.date)),
    removed:currentHearings.filter(hearing => !sourceDates.has(hearing.date)),
    patch, changed:Object.keys(patch).length > 0
  };
}

function detailsDiff(caseData, fetched={}){
  const beforeCaseNumber = String(caseData.caseNumber || '').trim();
  const beforeJudge = String(caseData.judge || '').trim();
  const currentCaseNumber = mainCaseNumber(beforeCaseNumber);
  const fetchedCaseNumber = mainCaseNumber(fetched.caseNumber);
  const patch = {};
  if(fetchedCaseNumber && currentCaseNumber !== fetchedCaseNumber) patch.caseNumber = fetchedCaseNumber;
  if(!beforeJudge && String(fetched.judge || '').trim()) patch.judge = String(fetched.judge).trim();
  const hearings = normalizedHearings(caseData.hearings);
  return {
    id:caseData.id, name:caseData.name || '', court:caseData.court || '', kind:'details',
    beforeHearings:hearings, afterHearings:hearings, beforeCaseNumber, beforeJudge,
    added:[], removed:[], patch, changed:Object.keys(patch).length > 0
  };
}

function fromFirestoreValue(value){
  if(!value || typeof value !== 'object') return null;
  if('stringValue' in value) return value.stringValue;
  if('integerValue' in value) return Number(value.integerValue);
  if('doubleValue' in value) return Number(value.doubleValue);
  if('booleanValue' in value) return Boolean(value.booleanValue);
  if('timestampValue' in value) return value.timestampValue;
  if('nullValue' in value) return null;
  if('arrayValue' in value) return (value.arrayValue.values || []).map(fromFirestoreValue);
  if('mapValue' in value){
    return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, item]) => [key, fromFirestoreValue(item)]));
  }
  return null;
}

function firestoreFieldsToObject(fields){
  return Object.fromEntries(Object.entries(fields || {}).map(([key, value]) => [key, fromFirestoreValue(value)]));
}

function toFirestoreValue(value){
  if(value === null || value === undefined) return { nullValue:null };
  if(Array.isArray(value)) return { arrayValue:{ values:value.map(toFirestoreValue) } };
  if(typeof value === 'string') return { stringValue:value };
  if(typeof value === 'boolean') return { booleanValue:value };
  if(typeof value === 'number') return Number.isInteger(value) ? { integerValue:String(value) } : { doubleValue:value };
  if(typeof value === 'object'){
    return { mapValue:{ fields:Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toFirestoreValue(item)])) } };
  }
  return { stringValue:String(value) };
}

function toFirestoreFields(data){
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, toFirestoreValue(value)]));
}

function firestoreUrl(env, documentPath=''){
  const projectId = String(env.FIREBASE_PROJECT_ID || '').trim();
  const apiKey = String(env.FIREBASE_API_KEY || '').trim();
  if(!projectId || !apiKey) throw new Error('Не настроено подключение Worker к Firestore.');
  const path = documentPath ? `/${documentPath}` : '';
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents${path}?key=${encodeURIComponent(apiKey)}`;
}

async function firestoreRequest(env, documentPath, options={}){
  const response = await fetch(firestoreUrl(env, documentPath), options);
  if(!response.ok){
    const body = await response.text();
    throw new Error(`Firestore вернул HTTP ${response.status}: ${body.slice(0, 180)}`);
  }
  if(response.status === 204) return null;
  return response.json();
}

async function readCourtCases(env){
  const payload = await firestoreRequest(env, 'courtCases');
  return (payload.documents || []).map(document => ({
    id:String(document.name || '').split('/').pop(),
    ...firestoreFieldsToObject(document.fields)
  }));
}

async function writeAutoUpdate(env, payload){
  await firestoreRequest(env, AUTO_UPDATE_DOCUMENT, {
    method:'PATCH',
    headers:{ 'content-type':'application/json; charset=utf-8' },
    body:JSON.stringify({ fields:toFirestoreFields(payload) })
  });
}

async function clearAutoUpdate(env){
  await firestoreRequest(env, AUTO_UPDATE_DOCUMENT, { method:'DELETE' });
}

export function extractUpcomingHearings(html){
  const movement = String(html || '').match(/<div\b[^>]*\bid\s*=\s*['"]cont2['"][^>]*>[\s\S]*?<table\b[^>]*>([\s\S]*?)<\/table>/i)?.[1];
  if(!movement) throw new Error('На странице не найдена таблица «Движение дела».');

  const today = moscowToday();
  const seen = new Set();
  const hearings = [];
  const rows = movement.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi);
  for(const row of rows){
    const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => htmlText(cell[1]));
    if(cells.length < 3 || !/^(?:предварительное\s+)?судебное\s+заседание\s*$/i.test(cells[0])) continue;
    // В заполненной графе «Результат события» уже состоявшееся заседание.
    if(String(cells[4] || '').trim()) continue;
    const date = toIsoDateTime(cells[1], cells[2]);
    if(!date || date.slice(0, 10) < today || seen.has(date)) continue;
    seen.add(date);
    hearings.push({ date, place:String(cells[3] || '').trim() });
  }
  return hearings.sort((a,b) => a.date.localeCompare(b.date));
}

export function extractCaseMetadata(html){
  const source = String(html || '');
  const caseBlock = source.match(/<div\b[^>]*\bclass\s*=\s*(?:['"]casenumber['"]|casenumber)(?=\s|>|\/)[^>]*>([\s\S]*?)<\/div>/i)?.[1] || '';
  const caseNumber = mainCaseNumber(htmlText(caseBlock).replace(/^дело\s*№?\s*/i, ''));

  let judge = '';
  const rows = source.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi);
  for(const row of rows){
    const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => htmlText(cell[1]));
    if(cells.length >= 2 && /^судья\s*$/i.test(cells[0])){
      judge = String(cells[1] || '').trim();
      break;
    }
  }
  return { caseNumber, judge };
}

async function fetchWithTimeout(url){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try{
    return await fetch(url, {
      method:'GET', signal:controller.signal,
      headers:{ 'accept':'text/html,application/xhtml+xml' },
      redirect:'follow'
    });
  }finally{
    clearTimeout(timer);
  }
}

async function readCourtHtml(response){
  const bytes = await response.arrayBuffer();
  const charset = response.headers.get('content-type')?.match(/charset\s*=\s*([\w-]+)/i)?.[1]?.toLowerCase();
  // Суды обычно явно присылают windows-1251. Это указание надёжнее
  // эвристики по наличию заседаний: у завершённого или перенесённого дела
  // подходящей строки может не быть, но реквизиты всё равно должны читаться
  // в правильной кодировке.
  if(charset){
    try{
      return new TextDecoder(charset).decode(bytes);
    }catch(_err){
      // Если сервер указал неподдерживаемую кодировку, применяем резервный вариант.
    }
  }

  const utf8 = new TextDecoder('utf-8').decode(bytes);
  if(/[А-Яа-яЁё]/.test(utf8)) return utf8;
  try{
    return new TextDecoder('windows-1251').decode(bytes);
  }catch(_err){
    return utf8;
  }
}

async function checkCase(input){
  const id = String(input?.id || '').trim();
  const name = String(input?.name || '').trim();
  const caseUrl = String(input?.caseUrl || '').trim();
  if(!id) return { id:'', status:'error', message:'не передан идентификатор карточки' };
  if(!isCourtPageUrl(caseUrl)) return { id, status:'error', message:'допустимы только HTTPS-ссылки на страницы sudrf.ru' };

  try{
    const response = await fetchWithTimeout(caseUrl);
    if(!response.ok) return { id, status:'error', message:`страница суда вернула HTTP ${response.status}` };
    const html = await readCourtHtml(response);
    const hearings = extractUpcomingHearings(html);
    const { caseNumber, judge } = extractCaseMetadata(html);
    return { id, name, status:'ok', hearings, caseNumber, judge, checkedAt:new Date().toISOString() };
  }catch(error){
    const timeout = error?.name === 'AbortError';
    return { id, status:'error', message:timeout ? 'страница суда не ответила за 25 секунд' : 'не удалось загрузить страницу суда' };
  }
}

async function runScheduledCourtCheck(env){
  const courtCases = await readCourtCases(env);
  const casesToCheck = courtCases
    .filter(caseData => !isInactiveCourtCase(caseData))
    .map(caseData => ({ id:caseData.id, name:caseData.name || '', caseUrl:String(caseData.caseUrl || '').trim(), caseData }))
    .filter(item => item.caseUrl);

  const withoutLinks = courtCases.filter(caseData => !isInactiveCourtCase(caseData) && !String(caseData.caseUrl || '').trim()).length;
  const results = [];
  for(const item of casesToCheck){
    results.push(await checkCase(item));
  }

  const changes = [];
  const errors = [];
  for(const result of results){
    const item = casesToCheck.find(candidate => candidate.id === result?.id);
    if(!item) continue;
    if(result.status !== 'ok'){
      errors.push({ name:item.name, message:result.message || 'не удалось прочитать страницу суда' });
      continue;
    }
    const hearingChange = hearingDiff(item.caseData, result);
    const detailsChange = detailsDiff(item.caseData, result);
    if(hearingChange.changed) changes.push(hearingChange);
    if(detailsChange.changed) changes.push(detailsChange);
  }

  // Ошибка чтения не должна стирать уже найденные и ещё не рассмотренные
  // сотрудниками предложения. При успешной проверке без различий старый пакет
  // можно удалить: это означает, что данные карточек уже актуальны.
  if(changes.length){
    const checkedAt = new Date().toISOString();
    await writeAutoUpdate(env, {
      status:'pending', version:1,
      runId:`scheduled-${checkedAt}-${crypto.randomUUID()}`,
      checkedAt, checkedCount:results.length, withoutLinks,
      changes, errors
    });
  }else if(!errors.length){
    await clearAutoUpdate(env);
  }

  return { checked:results.length, changes:changes.length, errors:errors.length, withoutLinks };
}

export default {
  async scheduled(_controller, env, ctx){
    ctx.waitUntil(runScheduledCourtCheck(env).catch(error => console.error('Автопроверка дел', error)));
  },
  async fetch(request){
    const origin = request.headers.get('Origin');
    if(request.method === 'OPTIONS'){
      if(origin !== ALLOWED_ORIGIN) return json(request, { error:'origin is not allowed' }, 403);
      return new Response(null, { status:204, headers:headersFor(request) });
    }
    if(origin !== ALLOWED_ORIGIN) return json(request, { error:'origin is not allowed' }, 403);
    if(request.method !== 'POST') return json(request, { error:'method not allowed' }, 405);

    let body;
    try{
      body = await request.json();
    }catch(_err){
      return json(request, { error:'invalid JSON' }, 400);
    }
    const cases = Array.isArray(body?.cases) ? body.cases : [];
    if(!cases.length || cases.length > MAX_CASES_PER_REQUEST){
      return json(request, { error:`send from 1 to ${MAX_CASES_PER_REQUEST} cases` }, 400);
    }

    const results = [];
    for(const item of cases){
      // Последовательные запросы намеренно не создают лишнюю нагрузку на сайты судов.
      results.push(await checkCase(item));
    }
    return json(request, { results });
  }
};
