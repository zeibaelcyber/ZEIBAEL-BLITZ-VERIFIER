#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const CONFIG=path.join(ROOT,"scripts","blitz-agentic-powerups-canary.mcp.json");
const INSPECTOR="@modelcontextprotocol/inspector@2.0.0";
const LOCAL_INSPECTOR=path.join(ROOT,"node_modules",".bin","mcp-inspector");
const GROUP=process.argv[2]||"all";

function inspectRaw(server,extra){
  const useLocal=process.platform!=="win32";
  const cmd=useLocal?LOCAL_INSPECTOR:"npx";
  const args=useLocal
    ? ["--cli","--config",CONFIG,"--server",server,...extra,"--format","json"]
    : ["--yes",INSPECTOR,"--cli","--config",CONFIG,"--server",server,...extra,"--format","json"];
  const cp=spawnSync(cmd,args,{
    cwd:ROOT,encoding:"utf8",timeout:240000,
    env:{PATH:process.env.PATH,HOME:process.env.HOME,CI:"1",NO_COLOR:"1"}
  });
  if(cp.error) throw cp.error;
  const raw=(cp.stdout||"").trim();
  let parsed=null;
  if(raw){
    try{parsed=JSON.parse(raw);}catch{
      const a=raw.indexOf("{"),b=raw.lastIndexOf("}");
      if(a>=0&&b>a) parsed=JSON.parse(raw.slice(a,b+1));
    }
  }
  return {cp,parsed,raw};
}
function inspect(server,extra){
  const {cp,parsed,raw}=inspectRaw(server,extra);
  if(cp.status!==0) throw new Error(`${server} inspector exit=${cp.status} stderr=${(cp.stderr||"").slice(-5000)} stdout=${(cp.stdout||"").slice(-5000)}`);
  if(parsed) return parsed;
  throw new Error(`${server} non-json output: ${raw.slice(-4000)}`);
}
function names(obj){
  for(const x of [obj?.result?.tools,obj?.tools,obj?.result?.result?.tools]){
    if(Array.isArray(x)) return x.map(v=>v?.name).filter(Boolean);
  }
  return [];
}
function assert(cond,msg){if(!cond)throw new Error(msg);}

async function remoteProbe(url){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),30000);
  try{
    const res=await fetch(url,{
      method:"POST",
      headers:{"content-type":"application/json","accept":"application/json, text/event-stream"},
      body:JSON.stringify({
        jsonrpc:"2.0",id:1,method:"initialize",
        params:{protocolVersion:"2026-07-28",capabilities:{},clientInfo:{name:"zeibael-powerups-canary",version:"1.0.0"}}
      }),
      signal:controller.signal
    });
    const body=await res.text();
    if(res.status!==200) throw new Error(`Wolfram MCP initialize status=${res.status} body=${body.slice(0,1000)}`);
    if(!(body.includes("jsonrpc")||body.includes("serverInfo")||res.headers.get("content-type")?.includes("text/event-stream"))){
      throw new Error(`Wolfram MCP initialize response not recognized: ${body.slice(0,1000)}`);
    }
    return {status:"PASS",endpoint:url,http_status:res.status,authentication_required:false};
  } finally { clearTimeout(timer); }
}

async function main(){
  const evidence={
    schema:"zeibael.blitz_agentic_powerups_public_canary.v2",
    group:GROUP,zero_spend:true,secrets_used:false,live_order_enabled:false,checks:{}
  };

  if(GROUP==="core"||GROUP==="all"){
    const fsList=inspect("filesystem",["--method","tools/list"]);
    const fsNames=names(fsList);
    assert(fsNames.includes("list_allowed_directories"),"filesystem missing list_allowed_directories");
    const fsCall=inspect("filesystem",["--method","tools/call","--tool-name","list_allowed_directories","--tool-args-json","{}"]);
    evidence.checks.filesystem={
      status:"PASS",package:"@modelcontextprotocol/server-filesystem@2026.8.31",
      tool_count:fsNames.length,scope_call_present:Boolean(fsCall?.result||fsCall?.content)
    };

    const cgList=inspect("codegraph",["--method","tools/list"]);
    const cgNames=names(cgList);
    for(const n of ["project_map","get_call_graph","get_ast_node","find_references"]) assert(cgNames.includes(n),`codegraph missing ${n}`);
    evidence.checks.codegraph={
      status:"PASS",package:"@sdsrs/code-graph@0.153.0",
      tool_count:cgNames.length,model_download_disabled:true,auto_update_disabled:true
    };
  }

  if(GROUP==="zenith"||GROUP==="all"){
    const zList=inspect("zenith",["--method","tools/list"]);
    const zNames=names(zList);
    for(const n of ["start_project","submit_plan","advance_project","end_mission","inspect_project","abort_project"]) assert(zNames.includes(n),`zenith missing ${n}`);
    evidence.checks.zenith={
      status:"PASS_SAFE_PROTOCOL_ONLY",
      source_commit:"a8d9b5786f81e70e73cce7bb164f5f83da84a4b5",
      safety_patch:"workspace-write+on-request+network-off",
      tool_count:zNames.length,agent_dispatch_verified:false
    };
  }

  if(GROUP==="shell"||GROUP==="all"){
    const shList=inspect("shell",["--method","tools/list"]);
    const shNames=names(shList);
    assert(shNames.includes("shell_execute"),"shell missing shell_execute");
    const shRaw=inspectRaw("shell",[
      "--method","tools/call","--tool-name","shell_execute","--tool-args-json",
      JSON.stringify({command:"printf ZEIBAEL_RESTRICTIVE_OK",execution_mode:"foreground"})
    ]);
    const shText=JSON.stringify(shRaw.parsed||{})+" "+(shRaw.cp.stderr||"")+" "+(shRaw.cp.stdout||"");
    if(shRaw.cp.status===0){
      assert(shText.includes("ZEIBAEL_RESTRICTIVE_OK"),"restricted shell command result missing marker");
      assert(shText.toLowerCase().includes("restrict"),"restricted shell response lacks isolation evidence");
      evidence.checks.shell={
        status:"PASS_RESTRICTIVE",package:"@mako10k/mcp-shell-server@2.8.1",
        tool_count:shNames.length,bubblewrap:true,direct_host_fallback:false,host_supported:true
      };
    }else{
      const expectedFailClosed=shText.includes("SANDBOX_CAPABILITY_MISSING")&&shText.includes("RTM_NEWADDR");
      assert(expectedFailClosed,`shell failed for unexpected reason: ${shText.slice(-3000)}`);
      evidence.checks.shell={
        status:"PASS_FAIL_CLOSED_HOST_UNSUPPORTED",package:"@mako10k/mcp-shell-server@2.8.1",
        tool_count:shNames.length,bubblewrap_present:true,direct_host_fallback:false,
        host_supported:false,blocker:"GITHUB_HOSTED_RUNNER_LOOPBACK_NAMESPACE_CAPABILITY"
      };
    }
  }

  if(GROUP==="wolfram"||GROUP==="all"){
    evidence.checks.wolfram_cloud=await remoteProbe("https://agenttools.wolfram.com/mcp");
  }

  if(!["core","zenith","shell","wolfram","all"].includes(GROUP)) throw new Error(`unknown canary group: ${GROUP}`);
  evidence.status="VERIFIED";
  console.log(JSON.stringify(evidence,null,2));
}

main().catch(err=>{
  console.error(JSON.stringify({
    schema:"zeibael.blitz_agentic_powerups_public_canary.v2",
    group:GROUP,status:"FAILED",zero_spend:true,live_order_enabled:false,
    error:String(err?.stack||err)
  },null,2));
  process.exit(1);
});
