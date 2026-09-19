import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const WC_DIST=path.resolve(__dirname,'../node_modules/@webcontainer/api/dist');

const CANDIDATE = Number(process.env.CANDIDATE || '1');
const PORT = 4181;
const TIMEOUT_MS = 30000;

if (!Number.isInteger(CANDIDATE) || CANDIDATE < 1) throw new Error('Invalid CANDIDATE');

const html = `<!doctype html><meta charset="utf-8"><title>ZEIBAEL Accelerator Probe</title>
<pre id="status">BOOTING</pre><pre id="result"></pre>
<script type="module">
window.__done=false; window.__result=null;
let WebContainer=null;
try{
  const mod=await import('/wc/index.js');
  WebContainer=mod?.WebContainer||null;
}catch(e){
  window.__result={candidate:${CANDIDATE},ok:false,timeout:false,error:'WEBCONTAINER_LOCAL_IMPORT_FAILED:'+String(e?.message||e)};
  window.__done=true;
  throw e;
}
if(typeof WebContainer!=='function'){window.__result={candidate:${CANDIDATE},ok:false,timeout:false,error:'WEBCONTAINER_LOCAL_IMPORT_INVALID'};window.__done=true;throw new Error(window.__result.error)}

async function drain(proc){
  const r=proc.output.getReader();
  for(;;){const x=await r.read();if(x.done)break;}
}

(async()=>{
  const c=${CANDIDATE};
  const wc=await WebContainer.boot({coep:'credentialless'});
  const probe={hardwareConcurrency:navigator.hardwareConcurrency||null,deviceMemory:navigator.deviceMemory||null,coi:self.crossOriginIsolated,ua:navigator.userAgent};
  await wc.fs.writeFile('/package.json',JSON.stringify({name:'zeibael-accelerator-probe',version:'1.0.0',private:true,type:'module'}));
  await wc.fs.writeFile('/task.mjs',`
    import crypto from "node:crypto";
    const id=Number(process.argv[2]||0);
    const payload=JSON.stringify({id,symbol:"ZEIBAEL",checks:["schema","invariant","hash","json"],live_order_enabled:false});
    const parsed=JSON.parse(payload);
    if(parsed.live_order_enabled!==false) process.exit(2);
    const h=crypto.createHash("sha256").update(payload).digest("hex");
    if(h.length!==64) process.exit(3);
    let x=id;
    for(let i=0;i<25000;i++) x=(x+i)%1000003;
    if(!Number.isFinite(x)) process.exit(4);
  `);

  let completed=0,failed=0,timer;
  const started=performance.now();

  async function one(i){
    try{
      const p=await wc.spawn('node',['task.mjs',String(i)]);
      await drain(p);
      const code=await p.exit;
      completed++;
      if(code!==0)failed++;
    }catch{
      completed++;failed++;
    }
  }

  try{
    await Promise.race([
      Promise.all(Array.from({length:c},(_,i)=>one(i))),
      new Promise((_,rej)=>timer=setTimeout(()=>rej(new Error('STEP_TIMEOUT')),${TIMEOUT_MS}))
    ]);
    clearTimeout(timer);
    window.__result={candidate:c,ok:failed===0&&completed===c,timeout:false,elapsed_ms:Math.round(performance.now()-started),completed,failed,probe};
  }catch(e){
    clearTimeout(timer);
    window.__result={candidate:c,ok:false,timeout:String(e?.message||e)==='STEP_TIMEOUT',elapsed_ms:Math.round(performance.now()-started),completed,failed,error:String(e?.message||e),probe};
  }
  try{await wc.teardown()}catch{}
  window.__done=true;
})().catch(e=>{window.__result={candidate:${CANDIDATE},ok:false,timeout:false,error:String(e?.stack||e)};window.__done=true;});
</script>`;


async function persistEvidence(result){
  const endpoint='https://pfxcdxxxcyoinlksruoy.supabase.co/functions/v1/zeibael-blitz-worker-evidence';
  const runId=process.env.GITHUB_RUN_ID||String(Date.now());
  const benchmark_id='blitz-accelerator-capacity-'+runId;
  try{
    const r=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({benchmark_id,event:'attempt',worker_n:CANDIDATE,payload:{...result,github_run_id:runId,github_sha:process.env.GITHUB_SHA||null}})});
    return {ok:r.ok,status:r.status,benchmark_id};
  }catch(e){return {ok:false,error:String(e?.message||e),benchmark_id}}
}

const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url||'/','http://127.0.0.1:'+PORT);
    res.setHeader('cache-control','no-store');
    res.setHeader('Cross-Origin-Opener-Policy','same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy','credentialless');
    res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    if(url.pathname.startsWith('/wc/')){
      const rel=url.pathname.slice('/wc/'.length);
      const full=path.resolve(WC_DIST,rel);
      if(!full.startsWith(WC_DIST+path.sep) && full!==path.join(WC_DIST,rel)){res.writeHead(403);res.end('forbidden');return}
      const body=await fs.readFile(full);
      res.setHeader('content-type',rel.endsWith('.js')?'text/javascript; charset=utf-8':'application/octet-stream');
      res.end(body);return;
    }
    res.setHeader('content-type','text/html; charset=utf-8');
    res.end(html);
  }catch(e){res.writeHead(500,{'content-type':'text/plain; charset=utf-8'});res.end(String(e?.message||e))}
});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));

const browser=await puppeteer.launch({
  headless:true,
  args:[
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--site-per-process',
    '--isolate-origins=http://127.0.0.1:'+PORT,
    '--enable-features=SharedArrayBuffer,SiteIsolationForCrossOriginOpenerPolicy'
  ]
});
const page=await browser.newPage();
let result;
try{
  await page.goto('http://127.0.0.1:'+PORT+'/',{waitUntil:'domcontentloaded',timeout:30000});
  await page.waitForFunction(()=>window.__done===true,{timeout:90000,polling:250});
  result=await page.evaluate(()=>window.__result);
}catch(e){
  result={candidate:CANDIDATE,ok:false,timeout:false,host_error:String(e?.message||e)};
}
const persisted=await persistEvidence(result);
console.log('ZEIBAEL_ACCELERATOR_PROBE_RESULT='+JSON.stringify({...result,persisted}));
await page.close().catch(()=>{});
await browser.close();
server.close();
process.exit(result.ok?0:2);
