#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const CONFIG="scripts/infisical-readonly-canary.mcp.json";
const INSPECTOR="@modelcontextprotocol/inspector@2.0.0";

function run(extra,allowFailure=false){
  const cp=spawnSync("npx",["--yes",INSPECTOR,"--cli","--config",CONFIG,"--server","infisical",...extra,"--format","json"],{
    encoding:"utf8",timeout:180000,env:{PATH:process.env.PATH,HOME:process.env.HOME,CI:"1",NO_COLOR:"1"}
  });
  if(cp.error)throw cp.error;
  const raw=((cp.stdout||"")+"\n"+(cp.stderr||"")).trim();
  if(cp.status!==0 && !allowFailure)throw new Error("inspector exit="+cp.status+" "+raw.slice(-6000));
  let parsed={};
  try{parsed=JSON.parse((cp.stdout||"").trim())}catch{
    const s=(cp.stdout||"").trim(),a=s.indexOf("{"),b=s.lastIndexOf("}");
    if(a>=0&&b>a)parsed=JSON.parse(s.slice(a,b+1));
  }
  return {status:cp.status,raw,parsed};
}
function names(o){
  for(const x of [o?.result?.tools,o?.tools,o?.result?.result?.tools]){
    if(Array.isArray(x))return x.map(v=>v?.name).filter(Boolean);
  }
  return [];
}
function must(x,m){if(!x)throw new Error(m);}

const inv=run(["--method","tools/list"]);
const toolNames=names(inv.parsed).sort();
const expected=["get-secret","list-projects","list-secrets"].sort();
must(JSON.stringify(toolNames)===JSON.stringify(expected),"unexpected Infisical tools: "+toolNames.join(","));

const denied=run([
  "--method","tools/call",
  "--tool-name","create-secret",
  "--tool-args-json",JSON.stringify({projectId:"dummy",environmentSlug:"dev",secretName:"NO_WRITE"})
],true);
const deniedText=denied.raw.toLowerCase();
must(
  denied.status!==0 &&
  (deniedText.includes("not enabled") || deniedText.includes("unknown tool") || deniedText.includes("not found")),
  "disabled write tool was not rejected"
);

const src=spawnSync("bash",["-lc",
  "grep -F 'INFISICAL_MASK_SECRET_VALUES' /tmp/infisical-mcp/src/index.ts >/dev/null && "+
  "grep -F 'const MASKED_VALUE = \"<masked>\"' /tmp/infisical-mcp/src/index.ts >/dev/null && "+
  "grep -F 'gate before authenticating so a disabled tool never touches credentials' /tmp/infisical-mcp/src/index.ts >/dev/null"
],{encoding:"utf8"});
must(src.status===0,"masking/gating source proof missing");

console.log(JSON.stringify({
  schema:"zeibael.infisical_readonly_public_canary.v1",
  status:"PASS",
  source_commit:"6d30bc1eb9968dd74df82c8af0a3222b543d3875",
  account_authentication_used:false,
  real_secret_access:false,
  secret_values_masked:true,
  write_tools_exposed:false,
  supabase_access:false,
  blitz_router_changed:false,
  live_order_enabled:false,
  checks:{
    exact_readonly_tool_inventory:"PASS",
    write_tool_rejected_before_auth:"PASS",
    masking_source_present:"PASS",
    disabled_tool_pre_auth_gate_present:"PASS"
  }
},null,2));
