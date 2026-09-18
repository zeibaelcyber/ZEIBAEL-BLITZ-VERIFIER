import http from 'node:http';
import puppeteer from 'puppeteer';

const PORT = 4180;
const TIMEOUT_MS = 30000;
const HARD_CAP = 2048;
const CONFIRM_ROUNDS = 3;

const html = `<!doctype html>
<meta charset="utf-8">
<title>ZEIBAEL Blitz Accelerator Capacity</title>
<pre id="status">BOOTING</pre><pre id="result"></pre>
<script type="module">
import { WebContainer } from 'https://esm.sh/@webcontainer/api@1.6.4';

window.__done = false;
window.__result = null;
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');

async function drain(proc){
  const reader = proc.output.getReader();
  let out = '';
  for(;;){
    const r = await reader.read();
    if(r.done) break;
    out += r.value;
    if(out.length > 4096) out = out.slice(-4096);
  }
  return out;
}

async function main(){
  const c = Number(new URLSearchParams(location.search).get('c'));
  const wc = await WebContainer.boot({coep:'credentialless'});
  const probe = {
    hardwareConcurrency:navigator.hardwareConcurrency||null,
    deviceMemory:navigator.deviceMemory||null,
    crossOriginIsolated:self.crossOriginIsolated,
    ua:navigator.userAgent,
    webcontainer_api:'1.6.4'
  };

  await wc.fs.writeFile('/package.json', JSON.stringify({
    name:'zeibael-blitz-accelerator-bench',
    version:'1.0.0',
    private:true,
    type:'module'
  }));

  await wc.fs.writeFile('/task.mjs', `
    import crypto from "node:crypto";
    const id = Number(process.argv[2] || 0);
    const payload = JSON.stringify({
      id,
      symbol:"ZEIBAEL",
      checks:["schema","invariant","hash","json"],
      live_order_enabled:false
    });
    const parsed = JSON.parse(payload);
    if(parsed.live_order_enabled !== false) process.exit(2);
    const h = crypto.createHash("sha256").update(payload).digest("hex");
    if(h.length !== 64) process.exit(3);
    let x = id;
    for(let i=0;i<25000;i++) x = (x + i) % 1000003;
    if(!Number.isFinite(x)) process.exit(4);
  `);

  statusEl.textContent = 'RUNNING_'+c;
  const started = performance.now();
  let completed = 0, failed = 0;
  const samples = [];

  async function one(i){
    try{
      const p = await wc.spawn('node',['task.mjs',String(i)]);
      const output = await drain(p);
      const code = await p.exit;
      completed++;
      if(code !== 0){
        failed++;
        if(samples.length < 5) samples.push({i,code,output:output.slice(-400)});
      }
    }catch(e){
      completed++;
      failed++;
      if(samples.length < 5) samples.push({i,error:String(e?.message||e)});
    }
  }

  let timer;
  let timedOut = false;
  try{
    await Promise.race([
      Promise.all(Array.from({length:c},(_,i)=>one(i))),
      new Promise((_,reject)=>timer=setTimeout(()=>{
        timedOut = true;
        reject(new Error('STEP_TIMEOUT'));
      }, 30000))
    ]);
    clearTimeout(timer);
    const elapsed = Math.round(performance.now()-started);
    window.__result = {
      candidate:c,
      ok:failed===0 && completed===c,
      timeout:false,
      elapsed_ms:elapsed,
      completed,
      failed,
      samples,
      probe,
      workload:'ACCELERATOR_SLOT_V1'
    };
  }catch(e){
    clearTimeout(timer);
    const elapsed = Math.round(performance.now()-started);
    window.__result = {
      candidate:c,
      ok:false,
      timeout:timedOut || String(e?.message||e)==='STEP_TIMEOUT',
      elapsed_ms:elapsed,
      completed,
      failed,
      samples,
      error:String(e?.message||e),
      probe,
      workload:'ACCELERATOR_SLOT_V1'
    };
  }

  statusEl.textContent = window.__result.ok ? 'PASS_'+c : (window.__result.timeout ? 'TIMEOUT_'+c : 'FAIL_'+c);
  resultEl.textContent = JSON.stringify(window.__result,null,2);
  window.__done = true;
  try{ await wc.teardown(); }catch{}
}

main().catch(e=>{
  window.__result={ok:false,timeout:false,error:String(e?.stack||e)};
  resultEl.textContent=JSON.stringify(window.__result,null,2);
  statusEl.textContent='ERROR';
  window.__done=true;
});
</script>`;

const server = http.createServer((req,res)=>{
  res.setHeader('content-type','text/html; charset=utf-8');
  res.setHeader('cache-control','no-store');
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy','credentialless');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  res.end(html);
});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));

const browser = await puppeteer.launch({
  headless:true,
  args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
});

const probes = [];
async function probe(c,label){
  const page = await browser.newPage();
  await page.setViewport({width:1280,height:900});
  const t0 = Date.now();
  let r;
  try{
    await page.goto('http://127.0.0.1:'+PORT+'/?c='+c,{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForFunction(()=>window.__done===true,{timeout:90000,polling:250});
    r = await page.evaluate(()=>window.__result);
  }catch(e){
    r={candidate:c,ok:false,timeout:false,host_error:String(e?.message||e)};
  }
  r.label=label;
  r.host_elapsed_ms=Date.now()-t0;
  probes.push(r);
  console.log('ZEIBAEL_ACCELERATOR_PROBE='+JSON.stringify(r));
  await page.close().catch(()=>{});
  return r;
}

let low = 0;
let high = null;

const r384 = await probe(384,'historical_384');
const r512 = await probe(512,'historical_512');

if(r384.ok && !r512.ok){
  low=384; high=512;
}else if(!r384.ok){
  high=384;
  for(const c of [256,128,64,32,16,8,4,2,1]){
    const r=await probe(c,'search_down');
    if(r.ok){ low=c; break; }
    high=c;
  }
}else{
  low=512;
  for(const c of [768,1024,1536,2048]){
    const r=await probe(c,'extend_up');
    if(r.ok) low=c;
    else { high=c; break; }
  }
}

if(low===0){
  const result={schema:'zeibael.blitz.accelerator-capacity.v1',status:'NO_STABLE_CAPACITY',max_stable:null,first_timeout_or_fail:high,timeout_ms:TIMEOUT_MS,probes};
  console.log('ZEIBAEL_ACCELERATOR_RESULT='+JSON.stringify(result));
  await browser.close(); server.close(); process.exit(2);
}

if(high===null){
  const result={schema:'zeibael.blitz.accelerator-capacity.v1',status:'LOWER_BOUND_ONLY',max_stable:low,first_timeout_or_fail:null,timeout_ms:TIMEOUT_MS,hard_cap:HARD_CAP,probes};
  console.log('ZEIBAEL_ACCELERATOR_RESULT='+JSON.stringify(result));
  await browser.close(); server.close(); process.exit(0);
}

while(high-low>1){
  const mid=Math.floor((low+high)/2);
  const r=await probe(mid,'binary_search');
  if(r.ok) low=mid;
  else high=mid;
}

const confirmations=[];
for(let round=1; round<=CONFIRM_ROUNDS; round++){
  const good=await probe(low,'confirm_pass_'+round);
  const bad=await probe(high,'confirm_fail_'+round);
  confirmations.push({round,good,bad});
}

const exact = confirmations.every(x=>x.good.ok && !x.bad.ok && x.good.candidate===low && x.bad.candidate===high && high===low+1);
const timeoutBoundary = exact && confirmations.every(x=>x.bad.timeout===true);

const result={
  schema:'zeibael.blitz.accelerator-capacity.v1',
  status:exact ? (timeoutBoundary?'EXACT_TIMEOUT_BOUNDARY':'EXACT_FAILURE_BOUNDARY') : 'VARIABLE_BOUNDARY',
  workload:'ACCELERATOR_SLOT_V1',
  timeout_ms:TIMEOUT_MS,
  max_stable_parallel_slots: exact?low:null,
  first_timeout_or_fail: exact?high:null,
  safe_operating_slots: exact?Math.max(1,Math.floor(low*0.90)):null,
  historical_384:r384,
  historical_512:r512,
  confirmations,
  probes
};
console.log('ZEIBAEL_ACCELERATOR_RESULT='+JSON.stringify(result));

await browser.close();
server.close();
process.exit(exact||result.status==='LOWER_BOUND_ONLY'?0:2);
