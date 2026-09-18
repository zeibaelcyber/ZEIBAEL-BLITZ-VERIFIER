import http from 'node:http';
import puppeteer from 'puppeteer';

const PROFILE = process.env.PROFILE || 'LIGHT';
const PORT = 4174;
const CONFIG = {
  LIGHT: { timeout_ms: 15000, hard_cap: 1024, safe_ratio: 0.80 },
  IO: { timeout_ms: 20000, hard_cap: 512, safe_ratio: 0.75 },
  BUILD_TEST: { timeout_ms: 30000, hard_cap: 256, safe_ratio: 0.70 },
  CPU_HEAVY: { timeout_ms: 30000, hard_cap: 128, safe_ratio: 0.60 },
};
if (!CONFIG[PROFILE]) throw new Error('Unknown PROFILE '+PROFILE);
const P = CONFIG[PROFILE];
const CONFIRM_ROUNDS = 2;

const html = `<!doctype html>
<meta charset="utf-8">
<title>ZEIBAEL Capability ${PROFILE}</title>
<pre id="status">BOOTING</pre><pre id="result"></pre>
<script type="module">
import { WebContainer } from 'https://esm.sh/@webcontainer/api@1.6.4';
const PROFILE = ${JSON.stringify(PROFILE)};
const P = ${JSON.stringify(P)};
const statusEl=document.getElementById('status'), resultEl=document.getElementById('result');
window.__done=false; window.__result=null;

async function collect(proc){let out='';const r=proc.output.getReader();for(;;){const x=await r.read();if(x.done)break;out+=x.value;if(out.length>8192)out=out.slice(-8192)}return out}

function codeFor(i){
  if(PROFILE==='LIGHT') return 'import crypto from "node:crypto";let x='+i+';for(let j=0;j<15000;j++)x=(x+j)%1000003;const h=crypto.createHash("sha256").update(String(x)).digest("hex");if(h.length!==64)process.exit(1);';
  if(PROFILE==='IO') return 'import fs from "node:fs";import crypto from "node:crypto";const p="/tmp/z-'+i+'-"+process.pid;const b=Buffer.alloc(32768,'+(i%251)+');fs.writeFileSync(p,b);const x=fs.readFileSync(p);fs.unlinkSync(p);if(x.length!==32768)process.exit(1);crypto.createHash("sha256").update(x).digest("hex");';
  if(PROFILE==='BUILD_TEST') return 'import fs from "node:fs";import {spawnSync} from "node:child_process";const p="/tmp/m-'+i+'-"+process.pid+".mjs";fs.writeFileSync(p,"export const x="+('+i+'+1)+";");const r=spawnSync(process.execPath,["--check",p],{stdio:"ignore"});fs.unlinkSync(p);if(r.status!==0)process.exit(1);';
  return 'import crypto from "node:crypto";let x='+i+';for(let j=0;j<3500000;j++)x=(x+j)%1000000007;const h=crypto.createHash("sha256").update(String(x)).digest("hex");if(h.length!==64)process.exit(1);';
}

async function runCandidate(c){
  const wc=await WebContainer.boot({coep:'credentialless'});
  const probe={coi:self.crossOriginIsolated,sab:typeof SharedArrayBuffer,hardwareConcurrency:navigator.hardwareConcurrency||null,deviceMemory:navigator.deviceMemory||null,ua:navigator.userAgent,webcontainer_api:'1.6.4'};
  const taskCount=Math.max(c*2,8);
  await wc.fs.writeFile('/package.json',JSON.stringify({name:'zeibael-capability',version:'1.0.0',private:true,type:'module'}));
  for(let i=0;i<taskCount;i++)await wc.fs.writeFile('/t-'+i+'.mjs',codeFor(i));
  let cursor=0,completed=0,failed=0;
  const samples=[];
  async function worker(){for(;;){const i=cursor++;if(i>=taskCount)return;try{const pr=await wc.spawn('node',['t-'+i+'.mjs']);const output=await collect(pr);const ec=await pr.exit;completed++;if(ec!==0){failed++;if(samples.length<3)samples.push({i,exit_code:ec,output:output.slice(-1200)})}}catch(e){completed++;failed++;if(samples.length<3)samples.push({i,error:String(e?.stack||e)})}}}
  const started=performance.now(); let timer;
  try{
    await Promise.race([
      Promise.all(Array.from({length:Math.min(c,taskCount)},worker)),
      new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('STEP_TIMEOUT')),P.timeout_ms))
    ]);
    clearTimeout(timer);
    const r={candidate:c,ok:failed===0&&completed===taskCount,timeout:false,elapsed_ms:Math.round(performance.now()-started),completed,failed,tasks:taskCount,samples,probe};
    try{await wc.teardown()}catch{}
    return r;
  }catch(e){
    clearTimeout(timer);
    const r={candidate:c,ok:false,timeout:String(e?.message||e)==='STEP_TIMEOUT',elapsed_ms:Math.round(performance.now()-started),completed,failed,tasks:taskCount,error:String(e?.message||e),samples,probe};
    try{await wc.teardown()}catch{}
    return r;
  }
}

(async()=>{
  statusEl.textContent='RUNNING_'+PROFILE;
  const c=Number(new URLSearchParams(location.search).get('c'));
  window.__result=await runCandidate(c);
  resultEl.textContent=JSON.stringify(window.__result,null,2);
  statusEl.textContent=window.__result.ok?'PASS_'+c:(window.__result.timeout?'TIMEOUT_'+c:'FAIL_'+c);
  window.__done=true;
})().catch(e=>{window.__result={candidate:Number(new URLSearchParams(location.search).get('c')),ok:false,timeout:false,error:String(e?.stack||e)};resultEl.textContent=JSON.stringify(window.__result,null,2);statusEl.textContent='ERROR';window.__done=true});
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
const probes=[];

async function probe(c,label){
  const page=await browser.newPage();
  await page.setViewport({width:1280,height:900});
  const started=Date.now();
  let r;
  try{
    await page.goto('http://127.0.0.1:'+PORT+'/?c='+c,{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForFunction(()=>window.__done===true,{timeout:P.timeout_ms+60000,polling:250});
    r=await page.evaluate(()=>window.__result);
  }catch(e){
    r={candidate:c,ok:false,timeout:false,host_error:String(e?.message||e)};
  }
  r.label=label; r.host_elapsed_ms=Date.now()-started; probes.push(r);
  console.log('ZEIBAEL_CAPABILITY_PROBE='+JSON.stringify({profile:PROFILE,...r}));
  await page.close().catch(()=>{});
  return r;
}

let low=0, high=null, c=1;
while(c<=P.hard_cap){
  const r=await probe(c,'exponential');
  if(r.ok){
    low=c;
    if(c===P.hard_cap)break;
    c=Math.min(c*2,P.hard_cap);
    if(c===low)break;
  }else{ high=c; break; }
}

let result;
if(low===P.hard_cap && high===null){
  result={schema:'zeibael.blitz.capability-profile.v1',profile:PROFILE,status:'LOWER_BOUND_ONLY',burst_max:low,first_fail:null,safe_max:Math.max(1,Math.floor(low*P.safe_ratio)),config:P,probes};
}else if(low===0){
  result={schema:'zeibael.blitz.capability-profile.v1',profile:PROFILE,status:'NO_STABLE_BOUNDARY',burst_max:0,first_fail:high,safe_max:0,config:P,probes};
}else{
  while(high-low>1){
    const mid=Math.floor((low+high)/2);
    const r=await probe(mid,'binary_search');
    if(r.ok)low=mid;else high=mid;
  }
  const confirmations=[];
  for(let round=1;round<=CONFIRM_ROUNDS;round++){
    const good=await probe(low,'confirm_pass_'+round);
    const bad=await probe(high,'confirm_fail_'+round);
    confirmations.push({round,good,bad});
  }
  const exact=confirmations.every(x=>x.good.ok&&!x.bad.ok&&high===low+1);
  result={
    schema:'zeibael.blitz.capability-profile.v1',
    profile:PROFILE,
    status:exact?'EXACT':'VARIABLE',
    burst_max:exact?low:null,
    first_fail:exact?high:null,
    safe_max:Math.max(1,Math.floor(low*P.safe_ratio)),
    last_stable_observed:low,
    config:P,
    confirmations,
    probes
  };
}

console.log('ZEIBAEL_CAPABILITY_RESULT='+JSON.stringify(result));
await browser.close(); server.close();
process.exit(result.status==='EXACT'||result.status==='LOWER_BOUND_ONLY'?0:2);
