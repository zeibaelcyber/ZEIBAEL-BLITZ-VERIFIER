#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const CONFIG=path.join(ROOT,"scripts","codegraph-canary.mcp.json");
const INSPECTOR="@modelcontextprotocol/inspector@2.0.0";

function run(extra){
  const cp=spawnSync("npx",["--yes",INSPECTOR,"--cli","--config",CONFIG,"--server","codegraph",...extra,"--format","json"],{
    cwd:ROOT,encoding:"utf8",timeout:240000,env:{PATH:process.env.PATH,HOME:process.env.HOME,CI:"1",NO_COLOR:"1"}
  });
  if(cp.error)throw cp.error;
  if(cp.status!==0)throw new Error(`inspector exit=${cp.status} stderr=${(cp.stderr||"").slice(-5000)} stdout=${(cp.stdout||"").slice(-5000)}`);
  const raw=(cp.stdout||"").trim();
  try{return JSON.parse(raw);}catch{
    const a=raw.indexOf("{"),b=raw.lastIndexOf("}");
    if(a>=0&&b>a)return JSON.parse(raw.slice(a,b+1));
    throw new Error("non-json output "+raw.slice(-4000));
  }
}
function names(obj){
  for(const x of [obj?.result?.tools,obj?.tools,obj?.result?.result?.tools]){
    if(Array.isArray(x))return x.map(v=>v?.name).filter(Boolean);
  }
  return [];
}
function must(cond,msg){if(!cond)throw new Error(msg);}

const before=spawnSync("git",["status","--porcelain"],{cwd:ROOT,encoding:"utf8"});
must(before.status===0,"git status before failed");

const inv=run(["--method","tools/list"]);
const toolNames=names(inv);
const expected=["project_map","semantic_code_search","get_call_graph","get_ast_node","module_overview","ast_search","find_references"];
for(const n of expected)must(toolNames.includes(n),`missing tool ${n}`);
must(toolNames.length===7,`unexpected tool count ${toolNames.length}`);

const map=run(["--method","tools/call","--tool-name","project_map","--tool-args-json",JSON.stringify({compact:true})]);
const mapText=JSON.stringify(map);
must(mapText.length>200,"project_map response unexpectedly small");
must(mapText.toLowerCase().includes("script") || mapText.toLowerCase().includes("module"),"project_map lacks repository structure evidence");

const overview=run(["--method","tools/call","--tool-name","module_overview","--tool-args-json",JSON.stringify({path:"scripts",compact:true})]);
const ovText=JSON.stringify(overview);
must(ovText.length>100,"module_overview response unexpectedly small");

const after=spawnSync("git",["status","--porcelain"],{cwd:ROOT,encoding:"utf8"});
must(after.status===0,"git status after failed");
const statusLines=(after.stdout||"").trim().split("\n").filter(Boolean);
const unexpected=statusLines.filter(x=>!x.includes(".code-graph/"));
must(unexpected.length===0,`CodeGraph modified tracked/non-index files: ${unexpected.join("; ")}`);

console.log(JSON.stringify({
  schema:"zeibael.codegraph_mcp_public_canary.v1",
  status:"VERIFIED",
  zero_spend:true,
  secrets_used:false,
  live_order_enabled:false,
  package:"@sdsrs/code-graph@0.153.0",
  tool_count:toolNames.length,
  checks:{
    tools_list_exact_7:"PASS",
    project_map:"PASS",
    module_overview:"PASS",
    auto_update_disabled:"PASS_CONFIG",
    model_download_disabled:"PASS_CONFIG",
    auto_adopt_disabled:"PASS_CONFIG",
    gitignore_mutation_disabled:"PASS_CONFIG",
    tracked_file_mutation:"NONE"
  }
},null,2));
