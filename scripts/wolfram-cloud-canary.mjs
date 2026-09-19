#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL = "https://agenttools.wolfram.com/mcp";
function must(cond,msg){if(!cond)throw new Error(msg);}
function dump(x){return JSON.stringify(x);}

const transport = new StreamableHTTPClientTransport(new URL(URL));
const client = new Client(
  {name:"zeibael-wolfram-public-canary",version:"1.0.0"},
  {capabilities:{}}
);

try {
  await client.connect(transport);

  const inv=await client.listTools();
  const toolNames=(inv.tools||[]).map(x=>x.name).sort();
  const expected=["WolframAlpha","WolframContext","WolframLanguageEvaluator"].sort();
  must(toolNames.length===3,`expected 3 tools, got ${toolNames.length}: ${toolNames}`);
  must(JSON.stringify(toolNames)===JSON.stringify(expected),`unexpected tools: ${toolNames}`);

  const exact=await client.callTool({
    name:"WolframLanguageEvaluator",
    arguments:{code:"{2^100, Det[{{2,3},{5,7}}], FactorInteger[1234567891011]}",timeConstraint:30}
  });
  const exactText=dump(exact);
  must(exactText.includes("1267650600228229401496703205376"),"2^100 exact result missing");
  must(exactText.includes("630803"),"factorization evidence missing");

  const alpha=await client.callTool({
    name:"WolframAlpha",
    arguments:{query:"12345 * 67890"}
  });
  const alphaText=dump(alpha);
  must(alphaText.includes("838102050"),"WolframAlpha multiplication missing");

  console.log(JSON.stringify({
    schema:"zeibael.wolfram_cloud_mcp_public_canary.v1",
    status:"VERIFIED",
    endpoint:URL,
    transport:"MCP_SDK_STREAMABLE_HTTP",
    zero_spend_canary:true,
    secrets_used:false,
    authentication_supplied:false,
    live_order_enabled:false,
    tool_count:toolNames.length,
    tools:toolNames,
    checks:{
      connect:"PASS",
      tools_list_exact_3:"PASS",
      wolfram_language_exact_computation:"PASS",
      wolfram_alpha_computation:"PASS"
    }
  },null,2));
} finally {
  await client.close().catch(()=>{});
}
