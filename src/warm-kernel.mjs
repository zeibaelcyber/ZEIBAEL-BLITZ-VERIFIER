import { Worker } from "node:worker_threads";
import readline from "node:readline";
const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
const MAX_OUTPUT=6000;
const PREWARM_TARGET=Math.max(1,Math.min(8,Number(process.env.ZEIBAEL_KERNEL_PREWARM)||4));
const PREPARE_TIMEOUT_MS=5000;
const idle=[];
let preparing=0,poolSpawned=0,poolUses=0,poolColdFallbacks=0,poolReplenishments=0;
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
function poolState(){return {target:PREWARM_TARGET,ready:idle.length,preparing,spawned:poolSpawned,prewarmed_uses:poolUses,cold_fallbacks:poolColdFallbacks,replenishments:poolReplenishments}}
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
    void spawnPrepared().then(worker=>{
      if(idle.length<PREWARM_TARGET)idle.push(worker);
      else try{worker.terminate()}catch{}
    }).catch(()=>{});
  }
}
async function initializePool(){
  const rows=await Promise.allSettled(Array.from({length:PREWARM_TARGET},()=>spawnPrepared()));
  for(const row of rows)if(row.status==="fulfilled")idle.push(row.value);
  scheduleReplenish();
}
async function acquireWorker(){
  const worker=idle.pop();
  if(worker){
    poolUses++;
    scheduleReplenish();
    return {worker,prewarmed:true};
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
    worker.once("exit",code=>finish(code===0,code,code===0?undefined:"worker_exit_"+code));
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
