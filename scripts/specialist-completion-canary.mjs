#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT=process.cwd();
const CONFIG=path.join(ROOT,"scripts","specialist-completion-canary.mcp.json");
const INSPECTOR="@modelcontextprotocol/inspector@2.0.0";

function run(server,extra,allowFailure=false){
  const cp=spawnSync("npx",["--yes",INSPECTOR,"--cli","--config",CONFIG,"--server",server,...extra,"--format","json"],{
    cwd:ROOT,encoding:"utf8",timeout:240000,env:{PATH:process.env.PATH,HOME:process.env.HOME,CI:"1",NO_COLOR:"1"}
  });
  if(cp.error)throw cp.error;
  if(cp.status!==0 && !allowFailure)throw new Error(server+" exit="+cp.status+" stderr="+(cp.stderr||"").slice(-6000)+" stdout="+(cp.stdout||"").slice(-6000));
  const raw=(cp.stdout||cp.stderr||"").trim();
  try{return {parsed:JSON.parse(raw),status:cp.status,raw};}catch{
    const a=raw.indexOf("{"),b=raw.lastIndexOf("}");
    const parsed=(a>=0&&b>a)?JSON.parse(raw.slice(a,b+1)):{};
    return {parsed,status:cp.status,raw};
  }
}
function value(x){return x?.parsed ?? x}
function names(o){
  for(const x of [o?.result?.tools,o?.tools,o?.result?.result?.tools]){
    if(Array.isArray(x))return x.map(v=>v?.name).filter(Boolean);
  }
  return [];
}
function must(x,msg){if(!x)throw new Error(msg);}
function dump(x){return JSON.stringify(x);}

const trivyInv=run("trivy",["--method","tools/list"]);
const trivyTools=names(value(trivyInv));
for(const n of ["scan_filesystem","scan_image","scan_repository","trivy_version","findings_list","findings_get"]){
  must(trivyTools.includes(n),"trivy missing "+n);
}
const tv=run("trivy",["--method","tools/call","--tool-name","trivy_version","--tool-args-json","{}"]);
must(dump(value(tv)).length>20 && !dump(value(tv)).includes("\"isError\":true"),"trivy version call failed");

const dummy=path.join(ROOT,"dummy-security-target");
fs.mkdirSync(dummy,{recursive:true});
fs.writeFileSync(path.join(dummy,"dummy.env"),"FAKE_AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n");
const scan=run("trivy",[
  "--method","tools/call",
  "--tool-name","scan_filesystem",
  "--tool-args-json",JSON.stringify({
    target:dummy,
    targetType:"filesystem",
    scanType:["secret"],
    severities:["CRITICAL","HIGH","MEDIUM","LOW","UNKNOWN"],
    outputFormat:"json",
    fixedOnly:false
  })
]);
const scanText=dump(value(scan));
must(scanText.includes("batch") || scanText.includes("fingerprint"),"trivy filesystem scan did not return scan metadata");

const k6Inv=run("k6",["--method","tools/list"]);
const k6Tools=names(value(k6Inv));
must(k6Tools.includes("status"),"k6 missing status");
must(k6Tools.includes("http_get_load_test"),"k6 missing http_get_load_test");
const ks=run("k6",["--method","tools/call","--tool-name","status","--tool-args-json","{}"]);
must(dump(value(ks)).includes("OUT_OF_BAND_READ_ONLY_LOAD_TEST"),"k6 status receipt missing");
const kt=run("k6",[
  "--method","tools/call",
  "--tool-name","http_get_load_test",
  "--tool-args-json",JSON.stringify({url:"http://127.0.0.1:18080/",vus:1,duration_seconds:2})
]);
must(dump(value(kt)).includes("PASS"),"k6 localhost test failed");

const denied=run("k6",[
  "--method","tools/call",
  "--tool-name","http_get_load_test",
  "--tool-args-json",JSON.stringify({url:"https://example.com/",vus:1,duration_seconds:1})
],true);
const deniedText=(denied.raw||dump(value(denied))).toLowerCase();
must(denied.status!==0 && deniedText.includes("not allowlisted"),"k6 external origin was not rejected");

console.log(JSON.stringify({
  schema:"zeibael.specialist_completion_public_canary.v1",
  status:"PASS",
  system_interference:false,
  supabase_access:false,
  blitz_router_changed:false,
  production_targets:false,
  live_order_enabled:false,
  checks:{
    trivy_tools:trivyTools.length,
    trivy_version:"PASS",
    trivy_dummy_filesystem_scan:"PASS",
    k6_tools:k6Tools.length,
    k6_localhost_load_test:"PASS",
    k6_external_origin_rejected:"PASS"
  }
},null,2));
