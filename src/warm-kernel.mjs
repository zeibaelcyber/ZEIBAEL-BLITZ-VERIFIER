import { Worker } from "node:worker_threads";
import readline from "node:readline";
const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
const MAX_OUTPUT=6000;
const PREWARM_TARGET=Math.max(1,Math.min(8,Number(process.env.ZEIBAEL_KERNEL_PREWARM)||8));
const PREWARM_READY_TARGET=Math.max(1,Math.min(PREWARM_TARGET,Number(process.env.ZEIBAEL_KERNEL_READY_PREWARM)||1));
const PREWARM_STARTUP_PARALLELISM=Math.max(PREWARM_READY_TARGET,Math.min(PREWARM_TARGET,Number(process.env.ZEIBAEL_KERNEL_STARTUP_PARALLELISM)||2));
const PREPARE_TIMEOUT_MS=5000;
const idle=[],preparedWaiters=[];
let preparing=0,poolSpawned=0,poolUses=0,poolColdFallbacks=0,poolReplenishments=0,poolWaitedForReplenish=0;
const BOOTSTRAP=`
import { parentPort } from "node:worker_threads";
parentPort.once("message", async (msg) => {
  let ok=true,error=null;
  try {
    const code=String(msg?.code||"");
    const url=new URL("data:text/javascript;base64,"+Buffer.from(code,"utf8").toString("base64"));
    await import(url.href);
  } catch (e) {
    ok=false;
    error=String(e&&e.stack||e&&e.message||e);
  }
  await new Promise(r=>setImmediate(r));
  parentPort.postMessage({type:"done",ok,error});
});
parentPort.postMessage({type:"ready"});
`;
const BOOTSTRAP_URL=new URL("data:text/javascript;base64,"+Buffer.from(BOOTSTRAP,"utf8").toString("base64"));
function trim(s){return String(s||"").slice(-MAX_OUTPUT)}
function poolState(){return {target:PREWARM_TARGET,ready_target:PREWARM_READY_TARGET,startup_parallelism:PREWARM_STARTUP_PARALLELISM,ready:idle.length,preparing,waiters:preparedWaiters.length,spawned:poolSpawned,prewarmed_uses:poolUses,cold_fallbacks:poolColdFallbacks,replenishments:poolReplenishments,waited_for_replenish:poolWaitedForReplenish}}
function offerPrepared(worker){
  const waiter=preparedWaiters.shift();
  if(waiter){waiter.resolve(worker);return}
  if(idle.length<PREWARM_TARGET)idle.push(worker);
  else try{void worker.terminate().catch(()=>{})}catch{}
}
async function waitForPrepared(){
  if(idle.length)return idle.pop();
  if(preparing<1)return null;
  poolWaitedForReplenish++;
  return await new Promise(resolve=>{
    const entry={resolve:(worker)=>{clearTimeout(timer);resolve(worker)}};
    const timer=setTimeout(()=>{
      const i=preparedWaiters.indexOf(entry);if(i>=0)preparedWaiters.splice(i,1);
      resolve(null)
    },PREPARE_TIMEOUT_MS+1000);
    preparedWaiters.push(entry)
  })
}
function spawnPrepared(){
  preparing++;poolSpawned++;
  return new Promise((resolve,reject)=>{
    const worker=new Worker(BOOTSTRAP_URL,{type:"module",stdout:true,stderr:true});
    let settled=false;
    const timer=setTimeout(()=>{
      if(settled)return;settled=true;
      try{worker.terminate()}catch{}
      reject(new Error("PREWARM_READY_TIMEOUT"));
    },PREPARE_TIMEOUT_MS);
    const fail=(error)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      reject(error instanceof Error?error:new Error(String(error)));
    };
    worker.once("error",fail);
    worker.once("exit",code=>{if(!settled)fail(new Error("PREWARM_EXIT_"+code))});
    worker.on("message",msg=>{
      if(settled||msg?.type!=="ready")return;
      settled=true;clearTimeout(timer);resolve(worker);
    });
  }).finally(()=>{preparing--})
}
function scheduleReplenish(){
  while(idle.length+preparing<PREWARM_TARGET){
    poolReplenishments++;
    void spawnPrepared().then(offerPrepared).catch(()=>{});
  }
}
async function initializePool(){
  const starters=Array.from({length:PREWARM_STARTUP_PARALLELISM},(_,i)=>
    spawnPrepared().then(worker=>({i,worker}))
  );
  let first;
  try{
    first=await Promise.any(starters);
  }catch{
    const fallback=await spawnPrepared();
    offerPrepared(fallback);
    scheduleReplenish();
    return
  }
  offerPrepared(first.worker);
  for(const p of starters){
    void p.then(row=>{
      if(row.i===first.i)return;
      offerPrepared(row.worker);
      scheduleReplenish();
    }).catch(async()=>{
      try{offerPrepared(await spawnPrepared())}catch{}
      scheduleReplenish();
    })
  }
}
async function acquireWorker(){
  let worker=idle.pop();
  if(worker){
    poolUses++;
    scheduleReplenish();
    return {worker,prewarmed:true};
  }
  if(preparing>0){
    worker=await waitForPrepared();
    if(worker){
      poolUses++;
      scheduleReplenish();
      return {worker,prewarmed:true};
    }
  }
  poolColdFallbacks++;
  const cold=await spawnPrepared();
  scheduleReplenish();
  return {worker:cold,prewarmed:false};
}
async function execute(req){
  const started=performance.now(),code=String(req.code||"");
  const timeout=Math.max(100,Math.min(30000,Number(req.timeout_ms)||10000));
  if(!code)return {request_id:req.request_id,id:req.id,ok:false,exit_code:2,elapsed_ms:0,error:"empty_code",output:"",worker_mode:"NONE",prewarm:poolState()};
  let acquired;
  try{acquired=await acquireWorker()}
  catch(e){return {request_id:req.request_id,id:req.id,ok:false,exit_code:1,elapsed_ms:Math.round(performance.now()-started),error:"WORKER_ACQUIRE_FAILED:"+trim(e&&e.stack||e),output:"",worker_mode:"ACQUIRE_FAILED",prewarm:poolState()}}
  const {worker,prewarmed}=acquired;
  return await new Promise((resolve)=>{
    let out="",err="",done=false;
    if(worker.stdout)worker.stdout.on("data",c=>{out=trim(out+c.toString())});
    if(worker.stderr)worker.stderr.on("data",c=>{err=trim(err+c.toString())});
    const finish=(ok,exitCode,error)=>{
      if(done)return;done=true;clearTimeout(timer);
      const elapsed=Math.round(performance.now()-started);
      setImmediate(()=>{
        try{void worker.terminate().catch(()=>{})}catch{}
        resolve({
          request_id:req.request_id,id:req.id,ok,exit_code:exitCode,elapsed_ms:elapsed,
          output:trim(out+(err?((out?"\n":"")+err):"")),
          error:error?trim(error):undefined,
          worker_mode:prewarmed?"PREWARMED_ONE_SHOT_WORKER":"ON_DEMAND_ONE_SHOT_WORKER",
          prewarm:poolState()
        });
      });
    };
    const timer=setTimeout(()=>finish(false,124,"timeout"),timeout);
    worker.once("error",e=>finish(false,1,e&&e.stack||e&&e.message||String(e)));
    worker.once("exit",code=>finish(false,Number(code)||1,"worker_exit_before_done_"+code));
    worker.on("message",msg=>{
      if(msg?.type!=="done")return;
      finish(msg.ok===true,msg.ok===true?0:1,msg.error||undefined);
    });
    try{worker.postMessage({code})}
    catch(e){finish(false,1,e&&e.stack||e&&e.message||String(e))}
  })
}
async function handle(line){
  let req;try{req=JSON.parse(line)}catch{process.stdout.write("ZK1:"+JSON.stringify({request_id:null,ok:false,error:"invalid_json"})+"\n");return}
  if(req&&req.command==="ping"){process.stdout.write("ZK1:"+JSON.stringify({request_id:req.request_id,ok:true,pong:true,pid:process.pid,prewarm:poolState()})+"\n");return}
  const result=await execute(req||{});process.stdout.write("ZK1:"+JSON.stringify(result)+"\n")
}
await initializePool();
rl.on("line",line=>{void handle(line)});
process.stdout.write("ZK1_READY\n");
