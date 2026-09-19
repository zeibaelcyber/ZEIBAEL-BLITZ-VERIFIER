#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const CONFIG=path.join(ROOT,"scripts","wolfram-cloud-canary.mcp.json");
const INSPECTOR="@modelcontextprotocol/inspector@2.0.0";

function run(extra){
  const cp=spawnSync("npx",["--yes",INSPECTOR,"--cli","--config",CONFIG,"--server","wolfram",...extra,"--format","json"],{
    cwd:ROOT,encoding:"utf8",timeout:180000,env:{PATH:process.env.PATH,HOME:process.env.HOME,CI:"1",NO_COLOR:"1"}
  });
  if(cp.error) throw cp.error;
  if(cp.status!==0) throw new Error(`inspector exit=${cp.status} stderr=${(cp.stderr||"").slice(-6000)} stdout=${(cp.stdout||"").slice(-6000)}`);
  const raw=(cp.stdout||"").trim();
  try{return JSON.parse(raw);}catch{
    const a=raw.indexOf("{"),b=raw.lastIndexOf("}");
    if(a>=0&&b>a)return JSON.parse(raw.slice(a,b+1));
    throw new Error("non-json output "+raw.slice(-4000));
  }
}
function names(obj){
  for(const x of [obj?.result?.tools,obj?.tools,obj?.result?.result?.tools]){
    if(Array.isArray(x)) return x.map(v=>v?.name).filter(Boolean);
  }
  return [];
}
function must(cond,msg){if(!cond)throw new Error(msg);}
function dump(x){return JSON.stringify(x);}

const inv=run(["--method","tools/list"]);
const toolNames=names(inv);
const expected=["WolframContext","WolframLanguageEvaluator","WolframAlpha"];
for(const n of expected)must(toolNames.includes(n),`missing ${n}`);
must(toolNames.length===3,`expected 3 tools, got ${toolNames.length}: ${toolNames}`);

const exact=run([
  "--method","tools/call",
  "--tool-name","WolframLanguageEvaluator",
  "--tool-args-json",JSON.stringify({code:"{2^100, Det[{{2,3},{5,7}}], FactorInteger[1234567891011]}",timeConstraint:30})
]);
const exactText=dump(exact);
must(exactText.includes("1267650600228229401496703205376"),"2^100 exact result missing");
must(exactText.includes("630803"),"factorization evidence missing");

const alpha=run([
  "--method","tools/call",
  "--tool-name","WolframAlpha",
  "--tool-args-json",JSON.stringify({query:"12345 * 67890"})
]);
const alphaText=dump(alpha);
must(alphaText.includes("838102050"),"WolframAlpha exact multiplication missing");

console.log(JSON.stringify({
  schema:"zeibael.wolfram_cloud_mcp_public_canary.v1",
  status:"VERIFIED",
  endpoint:"https://agenttools.wolfram.com/mcp",
  zero_spend_canary:true,
  secrets_used:false,
  authentication_supplied:false,
  live_order_enabled:false,
  tool_count:toolNames.length,
  tools:toolNames,
  checks:{
    tools_list_exact_3:"PASS",
    wolfram_language_exact_computation:"PASS",
    wolfram_alpha_computation:"PASS"
  }
},null,2));
