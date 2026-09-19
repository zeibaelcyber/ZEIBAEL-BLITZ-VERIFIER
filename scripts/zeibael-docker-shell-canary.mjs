#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const CONFIG=path.join(ROOT,"scripts","zeibael-docker-shell-canary.mcp.json");
const INSPECTOR="@modelcontextprotocol/inspector@2.0.0";

function call(method, toolName, toolArgs) {
  const args=["--yes",INSPECTOR,"--cli","--config",CONFIG,"--server","docker-shell","--method",method];
  if(toolName){
    args.push("--tool-name",toolName,"--tool-args-json",JSON.stringify(toolArgs||{}));
  }
  args.push("--format","json");
  const cp=spawnSync("npx",args,{cwd:ROOT,encoding:"utf8",timeout:240000,env:{PATH:process.env.PATH,HOME:process.env.HOME,CI:"1",NO_COLOR:"1"}});
  if(cp.error) throw cp.error;
  if(cp.status!==0) throw new Error(`inspector exit=${cp.status} stderr=${(cp.stderr||"").slice(-6000)} stdout=${(cp.stdout||"").slice(-6000)}`);
  const raw=(cp.stdout||"").trim();
  try{return JSON.parse(raw);}catch{
    const a=raw.indexOf("{"),b=raw.lastIndexOf("}");
    if(a>=0&&b>a)return JSON.parse(raw.slice(a,b+1));
    throw new Error("non-json inspector output "+raw.slice(-4000));
  }
}
function names(obj){
  for(const x of [obj?.result?.tools,obj?.tools,obj?.result?.result?.tools]){
    if(Array.isArray(x)) return x.map(v=>v?.name).filter(Boolean);
  }
  return [];
}
function textOf(obj){return JSON.stringify(obj);}
function must(cond,msg){if(!cond)throw new Error(msg);}

const inventory=call("tools/list");
const toolNames=names(inventory);
must(toolNames.includes("shell_execute"),"shell_execute missing");
must(toolNames.includes("sandbox_status"),"sandbox_status missing");

const status=call("tools/call","sandbox_status",{});
const st=textOf(status);
must(st.includes("zeibael-docker-sandbox-v1"),"isolation receipt missing");
must(st.includes("docker_available") && st.includes("true"),"Docker unavailable");

const marker=path.join(ROOT,"ZEIBAEL_HOST_MUTATION_MUST_NOT_EXIST.txt");
must(!existsSync(marker),"host marker exists before canary");
const execResult=call("tools/call","shell_execute",{
  command:"printf ZEIBAEL_DOCKER_OK > ZEIBAEL_HOST_MUTATION_MUST_NOT_EXIST.txt; printf ZEIBAEL_DOCKER_OK",
  timeout_seconds:60
});
const ex=textOf(execResult);
must(ex.includes("ZEIBAEL_DOCKER_OK"),"sandbox command failed");
must(ex.includes("network") && ex.includes("none"),"network-none receipt missing");
must(!existsSync(marker),"sandbox mutated host repository");

const networkResult=call("tools/call","shell_execute",{
  command:"wget -q -T 3 -O /tmp/net https://example.com; test $? -ne 0",
  timeout_seconds:20
});
must(textOf(networkResult).includes('"exit_code":0') || textOf(networkResult).includes('exit_code\\":0'),"network negative control did not pass");

console.log(JSON.stringify({
  schema:"zeibael.docker_shell_public_canary.v1",
  status:"VERIFIED",
  zero_spend:true,
  secrets_used:false,
  live_order_enabled:false,
  tools:toolNames,
  checks:{
    docker_available:"PASS",
    sandbox_command:"PASS",
    host_repo_read_only:"PASS",
    network_none:"PASS",
    isolation_receipt:"PASS"
  }
},null,2));
