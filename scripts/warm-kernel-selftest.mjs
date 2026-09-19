import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
const here=path.dirname(fileURLToPath(import.meta.url)),kernelPath=path.resolve(here,"../src/warm-kernel.mjs");
const proc=spawn(process.execPath,[kernelPath],{stdio:["pipe","pipe","pipe"]});
const rl=readline.createInterface({input:proc.stdout,crlfDelay:Infinity}),pending=new Map();
let ready=false,stderr="",seq=0;
proc.stderr.on("data",c=>{stderr=(stderr+c.toString()).slice(-6000)});
rl.on("line",line=>{if(line==="ZK1_READY"){ready=true;return}if(!line.startsWith("ZK1:"))return;const row=JSON.parse(line.slice(4)),p=pending.get(row.request_id);if(p){pending.delete(row.request_id);p.resolve(row)}});
async function waitReady(){const started=Date.now();while(!ready&&Date.now()-started<5000)await new Promise(r=>setTimeout(r,25));if(!ready)throw new Error("kernel_ready_timeout")}
async function call(payload){const request_id="self-"+(++seq);const p=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(request_id);reject(new Error("kernel_response_timeout"))},5000);pending.set(request_id,{resolve:v=>{clearTimeout(timer);resolve(v)},reject})});proc.stdin.write(JSON.stringify({...payload,request_id})+"\n");return await p}
try{
 await waitReady();const ping1=await call({command:"ping"});
 const t1=Date.now(),first=await Promise.all([call({id:"a",code:'import crypto from "node:crypto";console.log(crypto.createHash("sha256").update("A").digest("hex").slice(0,8))'}),call({id:"b",code:'console.log(21*2)'})]),firstMs=Date.now()-t1;
 const ping2=await call({command:"ping"});
 const t2=Date.now(),second=await Promise.all([call({id:"c",code:'console.log("reuse")'}),call({id:"d",code:'console.log(6*7)'})]),secondMs=Date.now()-t2;
 const ok=ping1.ok&&ping2.ok&&ping1.pid===ping2.pid&&first.every(x=>x.ok)&&second.every(x=>x.ok);
 console.log("BLITZ_WARM_KERNEL_SELFTEST="+JSON.stringify({schema:"zeibael.blitz.warm-kernel-selftest.v1",ok,kernel_pid:ping1.pid,pid_reused:ping1.pid===ping2.pid,first_ms:firstMs,second_ms:secondMs,first:first.map(x=>({id:x.id,ok:x.ok,elapsed_ms:x.elapsed_ms,output:x.output.trim()})),second:second.map(x=>({id:x.id,ok:x.ok,elapsed_ms:x.elapsed_ms,output:x.output.trim()})),live_order_enabled:false}));
 process.exitCode=ok?0:1;
}catch(error){console.log("BLITZ_WARM_KERNEL_SELFTEST="+JSON.stringify({schema:"zeibael.blitz.warm-kernel-selftest.v1",ok:false,error:String(error?.stack||error),stderr,live_order_enabled:false}));process.exitCode=1}finally{proc.kill()}
