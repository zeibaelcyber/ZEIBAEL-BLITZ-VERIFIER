import { spawn } from "node:child_process";
const c=spawn(process.execPath,["src/acker-accelerator.mjs","examples/hatchable-dependency-audit.packet.json"],{stdio:["ignore","pipe","pipe"]});
let o="",e="";c.stdout.on("data",d=>o+=d);c.stderr.on("data",d=>e+=d);
c.on("close",code=>{let p=null;try{p=JSON.parse(o)}catch{};const f=p?.results?.find(x=>x.id==="final")?.value;
const ok=code===0&&p?.failed===0&&p?.blocked===0&&f?.status==="VERIFIED";
console.log("ZEIBAEL_HATCHABLE_AUDIT_RESULT="+JSON.stringify({status:ok?"VERIFIED":"FAILED",runtime:"STACKBLITZ_WEBCONTAINER",jobs_total:p?.jobs_total,pass:p?.pass,failed:p?.failed,blocked:p?.blocked,final:f}));
if(!ok)process.exitCode=1;});