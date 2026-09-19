import { spawn } from "node:child_process";
const port=19091,token="selftest-token";
const child=spawn(process.execPath,["server.mjs"],{cwd:new URL(".",import.meta.url),env:{...process.env,PORT:String(port),ZEIBAEL_BURST_TOKEN:token},stdio:["ignore","pipe","pipe"]});
let logs="";child.stdout.on("data",c=>logs+=c.toString());child.stderr.on("data",c=>logs+=c.toString());
const sleep=ms=>new Promise(r=>setTimeout(r,ms));\nlet finalExitCode=1;\nfunction emit(payload,code){finalExitCode=code;process.stdout.write("BLITZ_WARM_RUNNER_SELFTEST="+JSON.stringify(payload)+"\\n")}
async function waitHealth(){for(let i=0;i<80;i++){try{const r=await fetch("http://127.0.0.1:"+port+"/health");const j=await r.json();if(j.ready)return j}catch{}await sleep(50)}throw new Error("health_timeout")}
async function burst(tasks){const r=await fetch("http://127.0.0.1:"+port+"/burst",{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify({route:{execution_class:"LOCAL_BLITZ",broker_required:false},tasks,concurrency:2})});return {status:r.status,body:await r.json()}}
try{
 const h1=await waitHealth();
 const first=await burst([{id:"a",code:'console.log(20+22)',kernel_safe:true,cache_safe:true},{id:"b",code:'import crypto from "node:crypto";console.log(crypto.createHash("sha256").update("x").digest("hex").slice(0,6))',kernel_safe:true,cache_safe:true}]);
 const second=await burst([{id:"a2",code:'console.log(20+22)',kernel_safe:true,cache_safe:true},{id:"b2",code:'import crypto from "node:crypto";console.log(crypto.createHash("sha256").update("x").digest("hex").slice(0,6))',kernel_safe:true,cache_safe:true}]);
 const broker=await fetch("http://127.0.0.1:"+port+"/burst",{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify({route:{execution_class:"CONNECTOR_BROKERED",broker_required:true},tasks:[{id:"x",code:'console.log(1)',kernel_safe:true}]})}).then(r=>r.json());
 const h2=await fetch("http://127.0.0.1:"+port+"/health").then(r=>r.json());
 const ok=h1.ready&&first.status===200&&first.body.ok&&second.body.ok&&second.body.cache.hits===2&&h1.kernel_pid===h2.kernel_pid&&broker.status==="BROKER_REQUIRED"&&broker.executed===false;
 console.log("BLITZ_WARM_RUNNER_SELFTEST="+JSON.stringify({schema:"zeibael.blitz.warm-runner-selftest.v2",ok,kernel_pid:h1.kernel_pid,pid_reused:h1.kernel_pid===h2.kernel_pid,first:first.body,second:second.body,broker,health:h2,live_order_enabled:false}));
 process.exitCode=ok?0:1;
}catch(e){emit({schema:"zeibael.blitz.warm-runner-selftest.v2",ok:false,error:String(e?.stack||e),logs,live_order_enabled:false},1)}finally{try{child.kill("SIGKILL")}catch{};setTimeout(()=>process.exit(finalExitCode),100)}
