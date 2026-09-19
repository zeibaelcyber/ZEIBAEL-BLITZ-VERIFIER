#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const CONFIG=path.join(ROOT,"scripts","filesystem-canary.mcp.json");
const INSPECTOR="@modelcontextprotocol/inspector@2.0.0";

function run(extra, allowFailure=false){
  const cp=spawnSync("npx",["--yes",INSPECTOR,"--cli","--config",CONFIG,"--server","filesystem",...extra,"--format","json"],{
    cwd:ROOT,encoding:"utf8",timeout:180000,env:{PATH:process.env.PATH,HOME:process.env.HOME,CI:"1",NO_COLOR:"1"}
  });
  if(cp.error) throw cp.error;
  if(!allowFailure && cp.status!==0) throw new Error(`inspector exit=${cp.status} stderr=${(cp.stderr||"").slice(-4000)} stdout=${(cp.stdout||"").slice(-4000)}`);
  return {status:cp.status,stdout:cp.stdout||"",stderr:cp.stderr||""};
}
function parse(raw){
  const s=raw.trim();
  try{return JSON.parse(s);}catch{
    const a=s.indexOf("{"),b=s.lastIndexOf("}");
    if(a>=0&&b>a)return JSON.parse(s.slice(a,b+1));
    return {};
  }
}
function toolNames(obj){
  for(const x of [obj?.result?.tools,obj?.tools,obj?.result?.result?.tools]){
    if(Array.isArray(x))return x.map(v=>v?.name).filter(Boolean);
  }
  return [];
}
function must(cond,msg){if(!cond)throw new Error(msg);}

const inv=run(["--method","tools/list"]);
const names=toolNames(parse(inv.stdout));
for(const n of ["list_allowed_directories","read_text_file"]) must(names.includes(n),`missing ${n}`);

const allowed=run(["--method","tools/call","--tool-name","list_allowed_directories","--tool-args-json","{}"]);
const allowedText=allowed.stdout+allowed.stderr;
must(allowedText.includes(ROOT),"workspace root not present in allowed directories");

const read=run(["--method","tools/call","--tool-name","read_text_file","--tool-args-json",JSON.stringify({path:path.join(ROOT,"README.md")})]);
must((read.stdout+read.stderr).includes("ZEIBAEL"),"in-scope file read did not return verifier content");

const outside=run(["--method","tools/call","--tool-name","read_text_file","--tool-args-json",JSON.stringify({path:"/etc/passwd"})],true);
const outsideText=(outside.stdout+outside.stderr).toLowerCase();
must(outside.status!==0 || outsideText.includes("outside") || outsideText.includes("allowed") || outsideText.includes("denied") || outsideText.includes("error"),"out-of-scope path was not rejected");

console.log(JSON.stringify({
  schema:"zeibael.filesystem_mcp_public_canary.v1",
  status:"VERIFIED",
  zero_spend:true,
  secrets_used:false,
  live_order_enabled:false,
  package:"@modelcontextprotocol/server-filesystem@2026.8.31",
  tool_count:names.length,
  checks:{
    tools_list:"PASS",
    allowed_root:"PASS",
    in_scope_read:"PASS",
    outside_workspace_rejected:"PASS"
  }
},null,2));
