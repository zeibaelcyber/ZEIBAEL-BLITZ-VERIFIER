import http from 'node:http';
import puppeteer from 'puppeteer';

const CANDIDATE = Number(process.env.CANDIDATE || '1');
const PORT = 4181;
const TIMEOUT_MS = 30000;

if (!Number.isInteger(CANDIDATE) || CANDIDATE < 1) throw new Error('Invalid CANDIDATE');

const html = `<!doctype html><meta charset="utf-8"><title>ZEIBAEL Accelerator Probe</title>
<pre id="status">BOOTING</pre><pre id="result"></pre>
<script type="module">
let WebContainer=null,lastImportError=null;
for(const url of ['https://esm.sh/@webcontainer/api@1.6.4','https://cdn.jsdelivr.net/npm/@webcontainer/api@1.6.4/+esm']){
  try{const mod=await import(url);if(typeof mod?.WebContainer==='function'){WebContainer=mod.WebContainer;break}}catch(e){lastImportError=String(e?.message||e)}
}
window.__done=false; window.__result=null;
if(!WebContainer){window.__result={candidate:${CANDIDATE},ok:false,timeout:false,error:'WEBCONTAINER_IMPORT_FAILED:'+String(lastImportError||'unknown')};window.__done=true;throw new Error(window.__result.error)}

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

const server=http.createServer((req,res)=>{
  res.setHeader('content-type','text/html; charset=utf-8');
  res.setHeader('cache-control','no-store');
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy','credentialless');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  res.end(html);
});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));

const browser=await puppeteer.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']});
const page=await browser.newPage();
let result;
try{
  await page.goto('http://127.0.0.1:'+PORT+'/',{waitUntil:'domcontentloaded',timeout:30000});
  await page.waitForFunction(()=>window.__done===true,{timeout:90000,polling:250});
  result=await page.evaluate(()=>window.__result);
}catch(e){
  result={candidate:CANDIDATE,ok:false,timeout:false,host_error:String(e?.message||e)};
}
console.log('ZEIBAEL_ACCELERATOR_PROBE_RESULT='+JSON.stringify(result));
await page.close().catch(()=>{});
await browser.close();
server.close();
process.exit(result.ok?0:2);
