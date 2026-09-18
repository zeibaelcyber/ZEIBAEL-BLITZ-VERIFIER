import http from 'node:http';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';

const PORT = 4174;
const PROFILE_CONFIG = {
  LIGHT: { timeout_ms:15000, hard_cap:1024, safe_ratio:0.80 },
  IO: { timeout_ms:20000, hard_cap:512, safe_ratio:0.75 },
  BUILD_TEST: { timeout_ms:30000, hard_cap:256, safe_ratio:0.70 },
  CPU_HEAVY: { timeout_ms:30000, hard_cap:128, safe_ratio:0.60 }
};
const CONFIRM_ROUNDS = 2;

const pageHtml = `<!doctype html>
<meta charset="utf-8">
<title>ZEIBAEL Blitz Capability Map Runner</title>
<pre id="status">BOOTING</pre>
<pre id="result"></pre>
<script type="module">
import { WebContainer } from 'https://esm.sh/@webcontainer/api@1.6.4';
const PROFILE_CONFIG = {"LIGHT":{"timeout_ms":15000,"hard_cap":1024,"safe_ratio":0.8},"IO":{"timeout_ms":20000,"hard_cap":512,"safe_ratio":0.75},"BUILD_TEST":{"timeout_ms":30000,"hard_cap":256,"safe_ratio":0.7},"CPU_HEAVY":{"timeout_ms":30000,"hard_cap":128,"safe_ratio":0.6}};
const CONFIRM_ROUNDS = 2;
const statusEl=document.getElementById('status');
const resultEl=document.getElementById('result');
window.__done=false; window.__result=null;
let wc=null;

async function collect(proc){let out='';const r=proc.output.getReader();for(;;){const x=await r.read();if(x.done)break;out+=x.value;if(out.length>4096)out=out.slice(-4096)}return out}
function taskCode(profile,i){
  if(profile==='LIGHT') return 'import crypto from "node:crypto";let x='+i+';for(let j=0;j<15000;j++)x=(x+j)%1000003;const h=crypto.createHash("sha256").update(String(x)).digest("hex");if(h.length!==64)process.exit(1);console.log("ok")';
  if(profile==='IO') return 'import fs from "node:fs";import crypto from "node:crypto";const p="/tmp/z-'+i+'-"+process.pid;const b=Buffer.alloc(32768,'+(i%251)+');fs.writeFileSync(p,b);const x=fs.readFileSync(p);fs.unlinkSync(p);if(x.length!==32768)process.exit(1);crypto.createHash("sha256").update(x).digest("hex");console.log("ok")';
  if(profile==='BUILD_TEST') return 'import fs from "node:fs";import {spawnSync} from "node:child_process";const p="/tmp/m-'+i+'-"+process.pid+".mjs";fs.writeFileSync(p,"export const x="+('+i+'+1)+";");const r=spawnSync(process.execPath,["--check",p],{stdio:"pipe"});fs.unlinkSync(p);if(r.status!==0){console.error(String(r.stderr||""));process.exit(1)}console.log("ok")';
  return 'import crypto from "node:crypto";let x='+i+';for(let j=0;j<3500000;j++)x=(x+j)%1000000007;const h=crypto.createHash("sha256").update(String(x)).digest("hex");if(h.length!==64)process.exit(1);console.log("ok")';
}
async function boot(){
  wc=await WebContainer.boot({coep:'credentialless'});
  await wc.fs.writeFile('/package.json',JSON.stringify({name:'zeibael-capability-map',version:'1.0.0',private:true,type:'module'}));
}
async function runCandidate(profile,c,timeoutMs){
  const taskCount=Math.max(c*2,8);
  const prefix='cap-'+profile.toLowerCase()+'-'+Date.now()+'-'+Math.random().toString(36).slice(2)+'-';
  for(let i=0;i<taskCount;i++) await wc.fs.writeFile(prefix+i+'.mjs',taskCode(profile,i));
  let cursor=0,completed=0,failed=0;
  const samples=[];
  const started=performance.now();
  async function worker(){
    for(;;){
      const i=cursor++;
      if(i>=taskCount)return;
      try{
        const p=await wc.spawn('node',[prefix+i+'.mjs']);
        const output=await collect(p);
        const code=await p.exit;
        completed++;
        if(code!==0){
          failed++;
          if(samples.length<3)samples.push({i,code,output:output.slice(-1200),path:prefix+i+'.mjs',source:taskCode(profile,i)});
        }
      }catch(e){
        completed++;failed++;
        if(samples.length<3)samples.push({i,error:String(e?.stack||e),path:prefix+i+'.mjs',source:taskCode(profile,i)});
      }
    }
  }
  let timer;
  try{
    await Promise.race([
      Promise.all(Array.from({length:Math.min(c,taskCount)},worker)),
      new Promise((_,rej)=>timer=setTimeout(()=>rej(new Error('STEP_TIMEOUT')),timeoutMs))
    ]);
    clearTimeout(timer);
    return {candidate:c,ok:failed===0&&completed===taskCount,timeout:false,elapsed_ms:Math.round(performance.now()-started),completed,failed,tasks:taskCount,samples};
  }catch(e){
    clearTimeout(timer);
    return {candidate:c,ok:false,timeout:String(e?.message||e)==='STEP_TIMEOUT',elapsed_ms:Math.round(performance.now()-started),completed,failed,tasks:taskCount,error:String(e?.message||e),samples};
  }
}
async function mapBoundary(profile,cfg){
  const probes=[];let low=0,high=null,c=1;
  while(c<=cfg.hard_cap){
    statusEl.textContent=profile+'_PROBE_'+c;
    const r=await runCandidate(profile,c,cfg.timeout_ms); probes.push(r);
    if(r.ok){low=c;if(c===cfg.hard_cap)break;c=Math.min(c*2,cfg.hard_cap);if(c===low)break}
    else{high=c;break}
  }
  if(low===cfg.hard_cap&&high===null)return {profile,status:'LOWER_BOUND_ONLY',burst_max:low,first_fail:null,safe_max:Math.max(1,Math.floor(low*cfg.safe_ratio)),probes,config:cfg};
  if(low===0)return {profile,status:'NO_STABLE_BOUNDARY',burst_max:0,first_fail:high,safe_max:0,probes,config:cfg};
  while(high-low>1){
    const mid=Math.floor((low+high)/2);statusEl.textContent=profile+'_BINARY_'+mid;
    const r=await runCandidate(profile,mid,cfg.timeout_ms);probes.push(r);if(r.ok)low=mid;else high=mid;
  }
  const confirmations=[];
  for(let round=1;round<=CONFIRM_ROUNDS;round++){
    statusEl.textContent=profile+'_CONFIRM_'+round+'_PASS_'+low;
    const good=await runCandidate(profile,low,cfg.timeout_ms);
    statusEl.textContent=profile+'_CONFIRM_'+round+'_FAIL_'+high;
    const bad=await runCandidate(profile,high,cfg.timeout_ms);
    probes.push(good,bad);confirmations.push({round,good,bad});
  }
  const exact=confirmations.every(x=>x.good.ok&&!x.bad.ok&&high===low+1);
  return {profile,status:exact?'EXACT':'VARIABLE',burst_max:exact?low:null,first_fail:exact?high:null,safe_max:Math.max(1,Math.floor(low*cfg.safe_ratio)),last_stable_observed:low,confirmations,probes,config:cfg};
}
async function main(){
  const env={generated_at:new Date().toISOString(),ua:navigator.userAgent,hardware_concurrency:navigator.hardwareConcurrency||null,device_memory_gb:navigator.deviceMemory||null,cross_origin_isolated:self.crossOriginIsolated,shared_array_buffer:typeof SharedArrayBuffer,webcontainer_api:'1.6.4'};
  await boot();
  const profiles={};
  for(const [name,cfg] of Object.entries(PROFILE_CONFIG)) profiles[name]=await mapBoundary(name,cfg);
  window.__result={schema:'zeibael.blitz.capability-map.v1',manual_only:true,environment:env,profiles,policy:{normal_mode:'use safe_max',burst_mode:'use burst_max only on explicit user request',redline:'never schedule first_fail for real work'}};
  resultEl.textContent=JSON.stringify(window.__result,null,2);statusEl.textContent='FULL_MAP_COMPLETE';window.__done=true;
}
main().catch(e=>{window.__result={schema:'zeibael.blitz.capability-map.v1',error:String(e?.stack||e)};resultEl.textContent=JSON.stringify(window.__result,null,2);statusEl.textContent='ERROR';window.__done=true});
</script>`;

const server=http.createServer((req,res)=>{
  res.setHeader('content-type','text/html; charset=utf-8');
  res.setHeader('cache-control','no-store');
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy','credentialless');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  res.end(pageHtml);
});
await new Promise(resolve=>server.listen(PORT,'127.0.0.1',resolve));

const browser=await puppeteer.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']});
const page=await browser.newPage();
await page.setViewport({width:1440,height:1000});
await page.goto('http://127.0.0.1:'+PORT+'/',{waitUntil:'domcontentloaded',timeout:30000});

let last='';
for(;;){
  const state=await page.evaluate(()=>({status:document.getElementById('status')?.textContent||'',done:window.__done===true,result:window.__result}));
  if(state.status!==last){console.log('CAPABILITY_STATUS='+state.status);last=state.status}
  if(state.done){
    await fs.mkdir('evidence',{recursive:true});
    await fs.writeFile('evidence/blitz-capability-map-latest.json',JSON.stringify(state.result,null,2));
    console.log('ZEIBAEL_BLITZ_CAPABILITY_MAP_RESULT='+JSON.stringify(state.result));
    break;
  }
  await new Promise(r=>setTimeout(r,1000));
}
await browser.close();server.close();
