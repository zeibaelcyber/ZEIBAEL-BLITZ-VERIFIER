import { Worker } from "node:worker_threads";
import readline from "node:readline";
const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
const MAX_OUTPUT=6000;
function trim(s){return String(s||"").slice(-MAX_OUTPUT)}
async function execute(req){
  const started=performance.now(),code=String(req.code||"");
  const timeout=Math.max(100,Math.min(30000,Number(req.timeout_ms)||10000));
  if(!code)return {request_id:req.request_id,id:req.id,ok:false,exit_code:2,elapsed_ms:0,error:"empty_code",output:""};
  return await new Promise((resolve)=>{
    let out="",err="",done=false;
    const url=new URL("data:text/javascript;base64,"+Buffer.from(code,"utf8").toString("base64"));
    const worker=new Worker(url,{type:"module",stdout:true,stderr:true});
    if(worker.stdout)worker.stdout.on("data",c=>{out=trim(out+c.toString())});
    if(worker.stderr)worker.stderr.on("data",c=>{err=trim(err+c.toString())});
    const finish=(ok,exitCode,error)=>{if(done)return;done=true;clearTimeout(timer);resolve({request_id:req.request_id,id:req.id,ok,exit_code:exitCode,elapsed_ms:Math.round(performance.now()-started),output:trim(out+(err?((out?"\n":"")+err):"")),error:error?trim(error):undefined})};
    const timer=setTimeout(async()=>{try{await worker.terminate()}catch{}finish(false,124,"timeout")},timeout);
    worker.once("error",e=>finish(false,1,e&&e.stack||e&&e.message||String(e)));
    worker.once("exit",code=>finish(code===0,code,code===0?undefined:"worker_exit_"+code));
  })
}
async function handle(line){
  let req;try{req=JSON.parse(line)}catch{process.stdout.write("ZK1:"+JSON.stringify({request_id:null,ok:false,error:"invalid_json"})+"\n");return}
  if(req&&req.command==="ping"){process.stdout.write("ZK1:"+JSON.stringify({request_id:req.request_id,ok:true,pong:true,pid:process.pid})+"\n");return}
  const result=await execute(req||{});process.stdout.write("ZK1:"+JSON.stringify(result)+"\n")
}
rl.on("line",line=>{void handle(line)});
process.stdout.write("ZK1_READY\n");
