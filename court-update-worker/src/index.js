const ALLOWED_ORIGIN = 'https://avlasevi4.github.io';
const MAX_CASES_PER_REQUEST = 12;
const FETCH_TIMEOUT_MS = 25000;

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
  const encodings = [...new Set([charset, 'utf-8', 'windows-1251'].filter(Boolean))];
  for(const encoding of encodings){
    try{
      const html = new TextDecoder(encoding).decode(bytes);
      if(/судебное\s+заседание/i.test(html)) return html;
    }catch(_err){
      // Если кодировка не поддерживается средой, пробуем следующую.
    }
  }
  // Возвращаем наиболее вероятный вариант, чтобы вызывающий код дал понятную ошибку
  // об отсутствующей таблице, а не об ошибке декодирования.
  return new TextDecoder('utf-8').decode(bytes);
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

export default {
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
