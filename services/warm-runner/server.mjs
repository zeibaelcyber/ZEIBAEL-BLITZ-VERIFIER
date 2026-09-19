import http from "node:http";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openBlitzResultCache } from "../../src/blitz-cache.mjs";

const PORT=Number(process.env.PORT||10080);
const TOKEN=process.env.ZEIBAEL_BURST_TOKEN||"";
const MAX_CONCURRENCY=57,MAX_TASKS=512,DEFAULT_TTL=10*60*1000;
const here=path.dirname(fileURLToPath(import.meta.url));
const KERNEL_PATH=path.resolve(here,"../../src/warm-kernel.mjs");
const cache=await openBlitzResultCache();

let proc=null,rl=null,ready=false,booting=null,seq=0,starts=0,restarts=0,lastBootAt=null,lastRunAt=null,runs=0,kernelPid=null;
const pending=new Map();

function safeEnv(){
  const out={NODE_ENV:"production",ZEIBAEL_LIVE_ORDER_ENABLED:"false"};
  for(const k of ["PATH","HOME","TMPDIR","TMP","TEMP","LANG"])if(process.env[k])out[k]=process.env[k];
  return out;
}
function failPending(error){
  for(const [id,p] of pending){clearTimeout(p.timer);p.reject(error)}
  pending.clear();
}
function reset(reason){
  ready=false;kernelPid=null;
  if(proc){try{proc.kill("SIGKILL")}catch{}}
  proc=null;rl=null;booting=null;
  failPending(new Error("KERNEL_RESET:"+reason));
}
async function ensureKernel(){
  if(ready&&proc&&!proc.killed)return;
  if(booting)return booting;
  booting=(async()=>{
    proc=spawn(process.execPath,[KERNEL_PATH],{stdio:["pipe","pipe","pipe"],env:safeEnv()});
    starts++;
    rl=readline.createInterface({input:proc.stdout,crlfDelay:Infinity});
    let readyResolve,readyReject;
    const readyP=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject});
    rl.on("line",line=>{
      if(line==="ZK1_READY"){ready=true;lastBootAt=new Date().toISOString();readyResolve(true);return}
      if(!line.startsWith("ZK1:"))return;
      try{
        const row=JSON.parse(line.slice(4)),p=pending.get(row.request_id);
        if(p){pending.delete(row.request_id);clearTimeout(p.timer);p.resolve(row)}
      }catch{}
    });
    proc.once("error",readyReject);
    proc.once("exit",code=>{
      const wasReady=ready;
      ready=false;kernelPid=null;proc=null;rl=null;booting=null;
      failPending(new Error("KERNEL_EXIT_"+code));
      if(wasReady)restarts++;
    });
    await Promise.race([readyP,new Promise((_,reject)=>setTimeout(()=>reject(new Error("KERNEL_READY_TIMEOUT")),5000))]);
    const pong=await callRaw({command:"ping"},3000);
    kernelPid=pong.pid||null;
  })().catch(e=>{reset("boot_failed");throw e}).finally(()=>{booting=null});
  return booting;
}
async function callRaw(payload,timeout=10000){
  if(!proc||!proc.stdin)throw new Error("KERNEL_NOT_READY");
  const request_id="wr-"+(++seq);
  const promise=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(request_id);reject(new Error("KERNEL_RESPONSE_TIMEOUT"))},timeout+1500);
    pending.set(request_id,{resolve,reject,timer});
  });
  proc.stdin.write(JSON.stringify({...payload,request_id})+"\n");
  return await promise;
}
async function callTask(task){
  await ensureKernel();
  try{return await callRaw({id:task.id,code:task.code,timeout_ms:task.timeout_ms},task.timeout_ms)}
  catch(first){restarts++;reset("task_failed");await ensureKernel();return await callRaw({id:task.id,code:task.code,timeout_ms:task.timeout_ms},task.timeout_ms)}
}
function cacheKey(task){
  if(task.cache_safe!==true)return null;
  return "warm-v2:"+crypto.createHash("sha256").update(JSON.stringify({code:task.code,timeout_ms:task.timeout_ms})).digest("hex");
}
function staticPureGuard(code){
  const s=String(code||"");
  const blocked=[
    /process\.env/i,/node:(?:http|https|net|tls|dgram|dns|child_process)/i,
    /\bfetch\s*\(/i,/XMLHttpRequest/i,/WebSocket/i,
    /\brequire\s*\(\s*["'](?:http|https|net|tls|dgram|dns|child_process)/i
  ];
  return blocked.every(r=>!r.test(s));
}
function normalizeTasks(tasks){
  if(!Array.isArray(tasks)||tasks.length<1||tasks.length>MAX_TASKS)throw new Error("tasks_1_to_512_required");
  return tasks.map((t,i)=>{
    const task={
      id:typeof t?.id==="string"?t.id.slice(0,64):"task-"+(i+1),
      code:typeof t?.code==="string"?t.code:"",
      timeout_ms:Math.max(500,Math.min(30000,Number(t?.timeout_ms)||10000)),
      cache_safe:t?.cache_safe===true,
      kernel_safe:t?.kernel_safe===true,
      side_effect_class:String(t?.side_effect_class||"NONE").toUpperCase()
    };
    if(!task.code)throw new Error("code_required:"+task.id);
    if(!task.kernel_safe)throw new Error("kernel_safe_required:"+task.id);
    if(task.side_effect_class!=="NONE")throw new Error("side_effects_forbidden:"+task.id);
    if(!staticPureGuard(task.code))throw new Error("pure_guard_rejected:"+task.id);
    return task;
  });
}
async function runTasks(tasks,requestedConcurrency){
  const normalized=normalizeTasks(tasks),results=new Array(normalized.length);
  let hits=0,misses=0,writes=0,executed=0,cursor=0;
  const effective=Math.max(1,Math.min(MAX_CONCURRENCY,Number(requestedConcurrency)||normalized.length,normalized.length));
  async function worker(){
    for(;;){
      const i=cursor++;if(i>=normalized.length)return;
      const task=normalized[i],key=cacheKey(task);
      if(key){
        const hit=cache.get(key);
        if(hit?.result?.ok===true){hits++;results[i]={...hit.result,id:task.id,cache_hit:true,elapsed_ms:0};continue}
        misses++;
      }
      const row=await callTask(task);executed++;
      const result={id:task.id,ok:row.ok===true,exit_code:row.exit_code,elapsed_ms:row.elapsed_ms,output:String(row.output||"").slice(-6000),error:row.error||null,cache_hit:false,execution_mode:"PERSISTENT_WARM_KERNEL"};
      results[i]=result;
      if(key&&result.ok){cache.set(key,result,DEFAULT_TTL);writes++}
    }
  }
  await Promise.all(Array.from({length:effective},worker));
  await cache.flush();
  return {ok:results.every(x=>x?.ok===true),results,concurrency:effective,executed,cache:{hits,misses,writes,entries:cache.size()}};
}
async function readJson(req){
  const chunks=[];for await(const c of req)chunks.push(c);
  const body=Buffer.concat(chunks).toString("utf8");return body?JSON.parse(body):{};
}
function send(res,status,body){res.statusCode=status;res.setHeader("content-type","application/json; charset=utf-8");res.setHeader("cache-control","no-store");res.end(JSON.stringify(body))}
const server=http.createServer(async(req,res)=>{
  if(req.url==="/health"){
    if(!ready){try{await ensureKernel()}catch{}}
    return send(res,200,{ok:ready,runner:"ZEIBAEL_BLITZ_WARM_RUNNER_V2",ready,kernel_pid:kernelPid,starts,restarts,last_boot_at:lastBootAt,last_run_at:lastRunAt,runs,cache_entries:cache.size(),max_concurrency:MAX_CONCURRENCY,canonical_state:"SUPABASE",zero_spend_required:true,live_order_enabled:false});
  }
  if(req.url!=="/burst"||req.method!=="POST")return send(res,404,{ok:false,error:"not_found"});
  if(!TOKEN||req.headers.authorization!=="Bearer "+TOKEN)return send(res,401,{ok:false,error:"unauthorized"});
  try{
    const body=await readJson(req);
    if(body?.live_order_enabled===true)return send(res,400,{ok:false,error:"live_order_forbidden"});
    const route=body?.route||{};
    if(route.execution_class&&route.execution_class!=="LOCAL_BLITZ")return send(res,200,{ok:true,status:"BROKER_REQUIRED",route,executed:false,live_order_enabled:false});
    if(route.broker_required===true)return send(res,200,{ok:true,status:"BROKER_REQUIRED",route,executed:false,live_order_enabled:false});
    const started=Date.now(),result=await runTasks(body.tasks,body.concurrency);
    lastRunAt=new Date().toISOString();runs++;
    return send(res,result.ok?200:422,{...result,lane:"ZEIBAEL_BLITZ_WARM_RUNNER_V2",elapsed_ms:Date.now()-started,kernel_pid:kernelPid,kernel_starts:starts,kernel_restarts:restarts,canonical_state:"SUPABASE",zero_spend_required:true,live_order_enabled:false});
  }catch(e){return send(res,400,{ok:false,error:String(e?.message||e),canonical_state:"SUPABASE",live_order_enabled:false})}
});
server.listen(PORT,"0.0.0.0",async()=>{console.log(JSON.stringify({event:"listen",port:PORT}));try{await ensureKernel();console.log(JSON.stringify({event:"warm_ready",kernel_pid:kernelPid}))}catch(e){console.error(JSON.stringify({event:"warm_boot_error",error:String(e?.message||e)}))}});
for(const sig of ["SIGTERM","SIGINT"])process.on(sig,()=>{reset(sig);server.close(()=>process.exit(0))});
