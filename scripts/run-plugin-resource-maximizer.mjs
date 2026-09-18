import { spawn } from "node:child_process";
const child=spawn(process.execPath,["src/acker-accelerator.mjs","examples/plugin-resource-maximizer.packet.json"],{stdio:["ignore","pipe","pipe"]});
let stdout="",stderr="";
child.stdout.on("data",d=>stdout+=d); child.stderr.on("data",d=>stderr+=d);
child.on("close",code=>{let p=null;try{p=JSON.parse(stdout)}catch{}
const final=p?.results?.find(x=>x?.id==="final")?.value??null;
const rows=(p?.results||[]).filter(x=>String(x.id).startsWith("p_")).map(x=>x.value);
const ok=code===0&&p?.failed===0&&p?.blocked===0&&final?.status==="VERIFIED";
console.log("ZEIBAEL_PLUGIN_MAXIMIZER_RESULT="+JSON.stringify({status:ok?"VERIFIED":"FAILED",runtime:"STACKBLITZ_WEBCONTAINER",jobs_total:p?.jobs_total,pass:p?.pass,failed:p?.failed,blocked:p?.blocked,final,rows}));
if(!ok) process.exitCode=1;});