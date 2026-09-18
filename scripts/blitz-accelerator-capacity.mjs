import puppeteer from 'puppeteer';

const TARGET='https://pfxcdxxxcyoinlksruoy.supabase.co/functions/v1/zeibael-stackblitz-direct?lane=stackblitz-compute-v1';
const TIMEOUT_MS=30000;
const HARD_CAP=512;
const CONFIRM_ROUNDS=3;

const browser=await puppeteer.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']});
let page=null;
const probes=[];

async function warmPage(){
  if(page&&!page.isClosed()) return page;
  page=await browser.newPage();
  await page.setViewport({width:1280,height:900});
  await page.goto(TARGET,{waitUntil:'domcontentloaded',timeout:30000});
  await page.waitForFunction(()=>typeof window.zeibaelRun==='function',{timeout:30000});
  await page.waitForFunction(()=>document.getElementById('status')?.textContent==='READY',{timeout:30000});
  return page;
}

function makeTasks(c){
  const code='import crypto from "node:crypto";const p=JSON.stringify({symbol:"ZEIBAEL",checks:["schema","hash","json"],live_order_enabled:false});const x=JSON.parse(p);if(x.live_order_enabled!==false)process.exit(2);const h=crypto.createHash("sha256").update(p).digest("hex");if(h.length!==64)process.exit(3);';
  return Array.from({length:c},(_,i)=>({id:'slot-'+(i+1),code}));
}

async function probe(c,label){
  const t0=Date.now();
  let result;
  try{
    const p=await warmPage();
    const payload=makeTasks(c);
    result=await p.evaluate(async ({payload,c,timeout})=>{
      let timer;
      try{
        return await Promise.race([
          window.zeibaelRun({tasks:payload,concurrency:c}),
          new Promise((_,rej)=>timer=setTimeout(()=>rej(new Error('STEP_TIMEOUT')),timeout))
        ]);
      }finally{clearTimeout(timer)}
    },{payload,c,timeout:TIMEOUT_MS});
    result={candidate:c,ok:result?.ok===true,timeout:false,elapsed_ms:result?.compute_elapsed_ms??(Date.now()-t0),tasks:result?.tasks??c,failed:Array.isArray(result?.results)?result.results.filter(x=>!x.ok).length:null};
  }catch(e){
    const msg=String(e?.message||e);
    result={candidate:c,ok:false,timeout:msg.includes('STEP_TIMEOUT'),host_error:msg,elapsed_ms:Date.now()-t0};
    try{await page?.close()}catch{}
    page=null;
  }
  result.label=label;
  result.host_elapsed_ms=Date.now()-t0;
  probes.push(result);
  console.log('ZEIBAEL_ACCELERATOR_PROBE='+JSON.stringify(result));
  return result;
}

let low=0,high=null;
for(const c of [1,2,4,8,16,24,32,48,64,96,128,192,256,384,512]){
  const r=await probe(c,'ramp');
  if(r.ok) low=c;
  else {high=c; break;}
}

if(low===0){
  const result={schema:'zeibael.blitz.accelerator-capacity.v2',status:'HARNESS_OR_RUNTIME_FAILURE_AT_1',max_stable_parallel_slots:null,first_timeout_or_fail:high,probes};
  console.log('ZEIBAEL_ACCELERATOR_RESULT='+JSON.stringify(result));
  await browser.close();
  process.exit(2);
}

if(high===null){
  const result={schema:'zeibael.blitz.accelerator-capacity.v2',status:'LOWER_BOUND_ONLY',max_stable_parallel_slots:low,first_timeout_or_fail:null,safe_operating_slots:Math.floor(low*0.9),probes};
  console.log('ZEIBAEL_ACCELERATOR_RESULT='+JSON.stringify(result));
  await browser.close();
  process.exit(0);
}

while(high-low>1){
  const mid=Math.floor((low+high)/2);
  const r=await probe(mid,'binary');
  if(r.ok) low=mid; else high=mid;
}

const confirmations=[];
for(let round=1;round<=CONFIRM_ROUNDS;round++){
  const good=await probe(low,'confirm_pass_'+round);
  const bad=await probe(high,'confirm_fail_'+round);
  confirmations.push({round,good,bad});
}

const exact=confirmations.every(x=>x.good.ok&&!x.bad.ok&&high===low+1);
const result={
  schema:'zeibael.blitz.accelerator-capacity.v2',
  status:exact?'EXACT_BOUNDARY_CONFIRMED':'VARIABLE_BOUNDARY',
  workload:'ACKER_ACCELERATOR_LIGHT_SHARD_V1',
  timeout_ms:TIMEOUT_MS,
  max_stable_parallel_slots:exact?low:null,
  first_timeout_or_fail:exact?high:null,
  safe_operating_slots:Math.max(1,Math.floor(low*0.9)),
  confirmations,
  probes
};
console.log('ZEIBAEL_ACCELERATOR_RESULT='+JSON.stringify(result));
await browser.close();
process.exit(exact?0:2);
