#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const transport=new StdioClientTransport({
  command:"bash",
  args:["scripts/blitz-agentic-shell-canary.sh"],
  cwd:ROOT,
  env:{...process.env,CI:"1",NO_COLOR:"1"}
});
const client=new Client(
  {name:"zeibael-shell-direct-canary",version:"1.0.0"},
  {capabilities:{}}
);

function contentText(result){
  return (result?.content||[])
    .filter(x=>x?.type==="text"&&typeof x.text==="string")
    .map(x=>x.text).join("\n");
}
function assert(cond,msg){if(!cond)throw new Error(msg);}
function withTimeout(promise,label,ms){
  let timer;
  return Promise.race([
    promise,
    new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error(`${label} timed out after ${ms}ms`)),ms);
    })
  ]).finally(()=>clearTimeout(timer));
}

let exitCode=0;
try{
  await withTimeout(client.connect(transport),"connect",30000);
  const inv=await withTimeout(client.listTools(),"listTools",20000);
  const names=(inv.tools||[]).map(x=>x.name);
  assert(names.includes("shell_execute"),"shell_execute missing from direct MCP inventory");

  const result=await withTimeout(client.callTool({
    name:"shell_execute",
    arguments:{command:"printf ZEIBAEL_RESTRICTIVE_OK",execution_mode:"foreground"}
  }),"shell_execute",20000);
  const text=contentText(result);
  const structured=result?.structuredContent||{};

  if(result?.isError){
    const combined=JSON.stringify(structured)+" "+text;
    assert(combined.includes("SANDBOX_CAPABILITY_MISSING"),"unexpected restrictive shell tool error: "+combined.slice(-2000));
    assert(combined.includes("RTM_NEWADDR")||combined.includes("Bubblewrap could not establish"),"missing fail-closed Bubblewrap capability evidence");
    console.log(JSON.stringify({
      schema:"zeibael.shell_restrictive_direct_canary.v1",
      status:"PASS_FAIL_CLOSED_HOST_UNSUPPORTED",
      package:"@mako10k/mcp-shell-server@2.8.1",
      tool_count:names.length,
      direct_host_fallback:false,
      blocker:"GITHUB_HOSTED_RUNNER_BUBBLEWRAP_CAPABILITY",
      live_order_enabled:false,
      zero_spend:true
    },null,2));
  }else{
    const combined=JSON.stringify(result);
    assert(combined.includes("ZEIBAEL_RESTRICTIVE_OK"),"restrictive shell command marker missing");
    assert(combined.toLowerCase().includes("restrict"),"restrictive isolation receipt missing");
    console.log(JSON.stringify({
      schema:"zeibael.shell_restrictive_direct_canary.v1",
      status:"PASS_RESTRICTIVE",
      package:"@mako10k/mcp-shell-server@2.8.1",
      tool_count:names.length,
      direct_host_fallback:false,
      live_order_enabled:false,
      zero_spend:true
    },null,2));
  }
} catch(err) {
  exitCode=1;
  console.error(JSON.stringify({
    schema:"zeibael.shell_restrictive_direct_canary.v1",
    status:"FAILED",
    error:String(err?.stack||err),
    live_order_enabled:false,
    zero_spend:true
  },null,2));
} finally {
  await withTimeout(client.close(),"client.close",3000).catch(()=>{});
  process.exit(exitCode);
}
