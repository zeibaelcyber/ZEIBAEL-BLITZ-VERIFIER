import http from 'node:http';
import puppeteer from 'puppeteer';

const PORT = 4173;
const MAX_EXTENSION = 1024;
const CONFIRM_ROUNDS = 2;

const pageHtml = `<!doctype html>
<meta charset="utf-8">
<title>ZEIBAEL Blitz v5 Exact</title>
<pre id="status">BOOTING</pre>
<pre id="result"></pre>
<script type="module">
import { WebContainer } from 'https://esm.sh/@webcontainer/api@1.6.4';

const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
window.__done = false;
window.__result = null;

async function collect(proc) {
  let out = '';
  const r = proc.output.getReader();
  for (;;) {
    const x = await r.read();
    if (x.done) break;
    out += x.value;
    if (out.length > 131072) out = out.slice(-131072);
  }
  return out;
}

function mk(id, code) { return { id, code }; }

function suite(mult) {
  const a = [];
  for (let k = 0; k < mult; k++) {
    a.push(mk('crypto-'+k,'import crypto from "node:crypto";const h=crypto.createHash("sha256").update("ZEIBAEL_"+String('+k+')).digest("hex");if(h.length!==64)process.exit(1);console.log("ok")'));
    a.push(mk('budget-'+k,'if(24*12*10+10!==2890)process.exit(1);console.log("ok")'));
    a.push(mk('clamp-'+k,'const M=8,f=v=>v===undefined?M:(!Number.isFinite(Number(v))||Number(v)<1?null:Math.max(1,Math.min(M,Math.floor(Number(v)))));const c=[[undefined,8],[0,null],[1,1],[4,4],[8,8],[9,8],[99,8],["bad",null],[1.9,1]];if(c.some(x=>f(x[0])!==x[1]))process.exit(1);console.log("ok")'));
    a.push(mk('batch-'+k,'const R=50,T=28672,M=8,e=new TextEncoder(),agents=Array.from({length:100},(_,i)=>({presenceKey:"worker:"+String(i),runId:"r",agentKey:"a",workerStatus:"RUNNING",sourceSurface:"SUPABASE_CONVEX_AGENT_PROJECTION_FEED_V2"}));let b=[],c=[];for(const x of agents){const d=c.concat([x]),z=e.encode(JSON.stringify({agents:d,observedAtMs:1})).byteLength;if(c.length&&(d.length>R||z>T)){b.push(c);c=[x]}else c=d;if(b.length>M)process.exit(1)}if(c.length)b.push(c);if(b.reduce((s,x)=>s+x.length,0)!==100||b.length>M)process.exit(1);console.log("ok")'));
    a.push(mk('payload-'+k,'const e=new TextEncoder(),MAX=32768;if(e.encode(JSON.stringify({x:"a".repeat(1024)})).byteLength>=MAX)process.exit(1);if(e.encode(JSON.stringify({x:"a".repeat(MAX+256)})).byteLength<=MAX)process.exit(1);console.log("ok")'));
    a.push(mk('retention-'+k,'const days=[7,7,30,30],limit=200,passes=5;if(days.some(x=>x<1)||limit!==200||passes!==5)process.exit(1);console.log("ok")'));
    a.push(mk('fuzz-'+k,'const M=8,f=v=>{const n=Number(v);if(!Number.isFinite(n)||n<1)return null;return Math.max(1,Math.min(M,Math.floor(n)))};for(let i=0;i<25000;i++){const v=(Math.random()-.15)*5000,r=f(v);if(r!==null&&(r<1||r>M||!Number.isInteger(r)))process.exit(1)}console.log("ok")'));
    a.push(mk('cpu-'+k,'let x=0;for(let i=0;i<3000000;i++)x=(x+i)%1000000007;if(!Number.isFinite(x))process.exit(1);console.log(x)'));
  }
  return a;
}

async function zeibaelRun(c, tasks) {
  const wc = await WebContainer.boot({ coep: 'credentialless' });
  const started = performance.now();
  await wc.fs.writeFile('/package.json', JSON.stringify({name:'zeibael-blitz-max',version:'1.0.0',private:true,type:'module'}));
  for (let i = 0; i < tasks.length; i++) await wc.fs.writeFile('/task-'+(i+1)+'.mjs', tasks[i].code);
  const results = new Array(tasks.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= tasks.length) return;
      const t = performance.now();
      try {
        const p = await wc.spawn('node', ['task-'+(i+1)+'.mjs']);
        const output = await collect(p);
        const code = await p.exit;
        results[i] = { id: tasks[i].id, ok: code === 0, exit_code: code, elapsed_ms: Math.round(performance.now()-t), output: output.slice(-2000) };
      } catch (e) {
        results[i] = { id: tasks[i].id, ok: false, elapsed_ms: Math.round(performance.now()-t), error: String(e?.message || e) };
      }
    }
  }
  const n = Math.max(1, Math.min(c, tasks.length));
  await Promise.all(Array.from({ length: n }, worker));
  return { ok: results.every(x => x && x.ok), concurrency: n, tasks: tasks.length, compute_elapsed_ms: Math.round(performance.now()-started), results, wc };
}

async function main() {
  const c = Number(new URLSearchParams(location.search).get('c'));
  const probe = { coi: self.crossOriginIsolated, sab: typeof SharedArrayBuffer, hardwareConcurrency: navigator.hardwareConcurrency || null, deviceMemory: navigator.deviceMemory || null, ua: navigator.userAgent };
  if (!Number.isInteger(c) || c < 1) {
    window.__result = { ok:false, error:'INVALID_CANDIDATE', c, probe };
    window.__done = true;
    return;
  }
  statusEl.textContent = 'RUNNING_'+c;
  const tasks = suite(Math.max(2, Math.ceil(c / 2)));
  const started = performance.now();
  let timer;
  let runPromise;
  let wc = null;
  try {
    runPromise = zeibaelRun(c, tasks);
    const run = await Promise.race([
      runPromise,
      new Promise((_, reject) => timer = setTimeout(() => reject(new Error('STEP_TIMEOUT')), 30000))
    ]);
    clearTimeout(timer);
    wc = run.wc;
    const failed = run.results.filter(x => !x.ok).length;
    window.__result = { candidate:c, ok:run.ok && failed===0, timeout:false, failed, elapsed_ms:Math.round(performance.now()-started), tasks:tasks.length, compute_elapsed_ms:run.compute_elapsed_ms, probe, criterion:'same_v5_suite_30s' };
  } catch (e) {
    clearTimeout(timer);
    window.__result = { candidate:c, ok:false, timeout:String(e?.message||e)==='STEP_TIMEOUT', error:String(e?.message||e), elapsed_ms:Math.round(performance.now()-started), tasks:tasks.length, probe, criterion:'same_v5_suite_30s' };
    if (runPromise) runPromise.then(x => { try { x.wc?.teardown(); } catch {} }).catch(()=>{});
  } finally {
    if (wc) { try { wc.teardown(); } catch {} }
    statusEl.textContent = window.__result.ok ? 'PASS_'+c : (window.__result.timeout ? 'TIMEOUT_'+c : 'FAIL_'+c);
    resultEl.textContent = JSON.stringify(window.__result, null, 2);
    window.__done = true;
  }
}
main();
</script>`;

const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.end(pageHtml);
});

await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve));

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'],
});

const probes = [];

async function probe(c, label) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const started = Date.now();
  let result;
  try {
    await page.goto(`http://127.0.0.1:${PORT}/?c=${c}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => window.__done === true, { timeout: 90000, polling: 250 });
    result = await page.evaluate(() => window.__result);
  } catch (e) {
    result = { candidate:c, ok:false, timeout:false, host_error:String(e?.message||e), criterion:'same_v5_suite_30s' };
  }
  result.label = label;
  result.host_elapsed_ms = Date.now() - started;
  probes.push(result);
  console.log('BLITZ_V5_PROBE='+JSON.stringify(result));
  await page.close().catch(()=>{});
  return result;
}

let low = null;
let high = null;

const r384 = await probe(384, 'revalidate_384');
const r512 = await probe(512, 'revalidate_512');

if (r384.ok && !r512.ok) {
  low = 384; high = 512;
} else if (!r384.ok) {
  const r1 = await probe(1, 'floor_1');
  if (!r1.ok) throw new Error('Harness failed even at concurrency 1: '+JSON.stringify(r1));
  low = 1; high = 384;
} else {
  low = 512;
  for (const c of [640, 768, 896, 1024]) {
    const r = await probe(c, 'extend_upper');
    if (!r.ok) { high = c; break; }
    low = c;
  }
  if (high === null) {
    const result = { schema:'zeibael.blitz.v5.exact.v1', status:'LOWER_BOUND_ONLY', max_stable_workers:low, first_failed_worker:null, probes };
    console.log('ZEIBAEL_BLITZ_V5_EXACT_RESULT='+JSON.stringify(result));
    await browser.close(); server.close();
    process.exit(2);
  }
}

while (high - low > 1) {
  const mid = Math.floor((low + high) / 2);
  const r = await probe(mid, 'binary_search');
  if (r.ok) low = mid;
  else high = mid;
}

const confirmations = [];
for (let round = 1; round <= CONFIRM_ROUNDS; round++) {
  const good = await probe(low, 'confirm_pass_'+round);
  const bad = await probe(high, 'confirm_fail_'+round);
  confirmations.push({ round, good, bad });
}

const exact = confirmations.every(x => x.good.ok && !x.bad.ok && x.good.candidate === low && x.bad.candidate === high && high === low + 1);
const highTimeout = confirmations.every(x => x.bad.timeout === true);
const result = {
  schema:'zeibael.blitz.v5.exact.v1',
  status: exact ? (highTimeout ? 'EXACT_TIMEOUT_BOUNDARY_CONFIRMED' : 'EXACT_FAILURE_BOUNDARY_CONFIRMED') : 'SESSION_VARIABILITY_OBSERVED',
  max_stable_workers: exact ? low : null,
  first_failed_worker: exact ? high : null,
  first_failure_is_timeout: exact ? highTimeout : null,
  criterion:'same v5 workload suite; each candidate has 30s timeout; all tasks must exit 0',
  revalidated_384:r384,
  revalidated_512:r512,
  confirmations,
  probes,
};
console.log('ZEIBAEL_BLITZ_V5_EXACT_RESULT='+JSON.stringify(result));

await browser.close();
server.close();
process.exit(exact ? 0 : 2);
