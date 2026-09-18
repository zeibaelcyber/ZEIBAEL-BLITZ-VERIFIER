import { spawn } from "node:child_process";
const child=spawn(process.execPath,["src/acker-accelerator.mjs","examples/remaining-plugins-evidence.packet.json"],{stdio:["ignore","pipe","pipe"]});
let stdout="",stderr="";
child.stdout.on("data",d=>stdout+=d);
child.stderr.on("data",d=>stderr+=d);
child.on("close",code=>{
  let parsed=null; try{parsed=JSON.parse(stdout)}catch{}
  const final=parsed?.results?.find(x=>x?.id==="final")?.value??null;
  const verified=code===0&&parsed?.failed===0&&parsed?.blocked===0&&parsed?.pass===parsed?.jobs_total&&final?.status==="VERIFIED";
  const result={schema:"zeibael.remaining_plugins.wave23.stackblitz_result.v1",status:verified?"VERIFIED":"FAILED",runtime:"STACKBLITZ_WEBCONTAINER",jobs_total:parsed?.jobs_total??null,pass:parsed?.pass??null,failed:parsed?.failed??null,blocked:parsed?.blocked??null,duration_ms:parsed?.duration_ms??null,final};
  console.log("ZEIBAEL_REMAINING_PLUGINS_RESULT="+JSON.stringify(result));
  if(!verified) process.exitCode=1;
});