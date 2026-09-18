import http from 'node:http';
import puppeteer from 'puppeteer';

const PORT = Number(process.env.PORT || 10000);
const TOKEN = process.env.ZEIBAEL_BURST_TOKEN || '';
const TARGET = 'https://pfxcdxxxcyoinlksruoy.supabase.co/functions/v1/zeibael-stackblitz-direct?lane=stackblitz-compute-v1';

let browser = null;
let page = null;
let ready = false;
let booting = null;
let lastBootAt = null;
let lastRunAt = null;
let runs = 0;

async function ensureReady() {
  if (ready && page && !page.isClosed()) return;
  if (booting) return booting;
  booting = (async () => {
    if (!browser) {
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
      });
    }
    if (!page || page.isClosed()) page = await browser.newPage();
    page.setDefaultTimeout(60000);
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => typeof window.zeibaelRun === 'function', { timeout: 30000 });
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'READY', { timeout: 30000 });
    ready = true;
    lastBootAt = new Date().toISOString();
  })().catch(err => {
    ready = false;
    throw err;
  }).finally(() => { booting = null; });
  return booting;
}

async function json(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  if (!body) return {};
  return JSON.parse(body);
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    return send(res, 200, {
      ok: true,
      runner: 'ZEIBAEL_BLITZ_WARM_ACCELERATOR_V1',
      ready,
      last_boot_at: lastBootAt,
      last_run_at: lastRunAt,
      runs,
      live_order_enabled: false
    });
  }

  if (req.url !== '/burst' || req.method !== 'POST') return send(res,404,{ok:false,error:'not_found'});
  const auth = req.headers.authorization || '';
  if (!TOKEN || auth !== 'Bearer ' + TOKEN) return send(res,401,{ok:false,error:'unauthorized'});

  try {
    const body = await json(req);
    const tasks = Array.isArray(body.tasks) ? body.tasks : [];
    if (tasks.length < 1 || tasks.length > 512) return send(res,400,{ok:false,error:'tasks_1_to_512_required'});
    const normalized = tasks.map((t,i)=>({
      id: typeof t?.id === 'string' ? t.id.slice(0,64) : 'task-'+(i+1),
      code: typeof t?.code === 'string' ? t.code : ''
    }));
    if (normalized.some(t => !t.code)) return send(res,400,{ok:false,error:'code_required'});

    const started = Date.now();
    await ensureReady();
    const result = await page.evaluate(async payload => {
      return await window.zeibaelRun({ tasks: payload, concurrency: payload.length });
    }, normalized);
    lastRunAt = new Date().toISOString();
    runs++;
    return send(res,200,{
      ok: result?.ok === true,
      lane: 'ZEIBAEL_BLITZ_WARM_ACCELERATOR_V1',
      requested_concurrency: normalized.length,
      elapsed_ms: Date.now()-started,
      result,
      live_order_enabled: false
    });
  } catch (e) {
    ready = false;
    return send(res,500,{ok:false,error:String(e?.message||e),live_order_enabled:false});
  }
});

server.listen(PORT,'0.0.0.0', async () => {
  console.log(JSON.stringify({event:'listen',port:PORT}));
  try { await ensureReady(); console.log(JSON.stringify({event:'warm_ready'})); }
  catch (e) { console.error(JSON.stringify({event:'warm_boot_error',error:String(e?.message||e)})); }
});
