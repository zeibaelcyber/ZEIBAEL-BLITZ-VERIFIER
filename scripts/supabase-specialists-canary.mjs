#!/usr/bin/env node
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const INSPECTOR="@modelcontextprotocol/inspector@2.0.0";
const CONFIG="scripts/supabase-specialists-canary.mcp.json";
function call(server,args){
  const cp=spawnSync("npx",["--yes",INSPECTOR,"--cli","--config",CONFIG,"--server",server,...args,"--format","json"],{encoding:"utf8",timeout:180000,env:{...process.env,CI:"1",NO_COLOR:"1"}});
  if(cp.error) throw cp.error;
  if(cp.status!==0) throw new Error(server+" exit="+cp.status+" "+(cp.stderr||"").slice(-5000));
  const raw=(cp.stdout||"").trim(); const a=raw.indexOf("{"),b=raw.lastIndexOf("}");
  return JSON.parse(a>=0&&b>=a?raw.slice(a,b+1):raw);
}
function names(o){for(const x of [o?.result?.tools,o?.tools,o?.result?.result?.tools])if(Array.isArray(x))return x.map(v=>v.name);return []}
fs.mkdirSync("canary-data",{recursive:true});
fs.writeFileSync("canary-data/sample.csv","ticker,value\nTEST,42\n");
const d=names(call("duckdb",["--method","tools/list"]));
for(const n of ["list_tables","describe_table","query","status"]) if(!d.includes(n)) throw new Error("duckdb missing "+n);
const dq=call("duckdb",["--method","tools/call","--tool-name","query","--tool-args-json",JSON.stringify({sql:"select * from sample_csv"})]);
if(!JSON.stringify(dq).includes("42")) throw new Error("duckdb query failed");
const r=names(call("redis",["--method","tools/list"]));
if(r.length<5) throw new Error("redis tool inventory unexpectedly small");
const up=spawnSync("bash",["scripts/run_upstash_full_mcp.sh"],{encoding:"utf8",timeout:20000,env:{PATH:process.env.PATH,HOME:process.env.HOME}});
if(up.status===0) throw new Error("upstash wrapper should fail closed without credentials");
console.log(JSON.stringify({status:"PASS",duckdb_tools:d.length,redis_tools:r.length,upstash_no_credential:"FAIL_CLOSED_PASS",supabase_mutation:false,live_order_enabled:false},null,2));
