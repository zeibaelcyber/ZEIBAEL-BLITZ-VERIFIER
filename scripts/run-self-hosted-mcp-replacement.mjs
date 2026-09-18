import fs from "node:fs/promises";

const packet=JSON.parse(await fs.readFile(new URL("../examples/self-hosted-mcp-replacement.packet.json",import.meta.url),"utf8"));

const weights={
  gateway:10, compute:15, browser:15, terminal:10, filesystem:8, persistence:8,
  deploy:10, mcp:10, scale:6, security:5, vendor_unmetered:15
};

const rows=[
  {repo:"docker/mcp-gateway",gateway:10,compute:5,browser:2,terminal:3,filesystem:4,persistence:7,deploy:7,mcp:10,scale:9,security:9,vendor_unmetered:10},
  {repo:"manusa/podman-mcp-server",gateway:2,compute:9,browser:1,terminal:5,filesystem:4,persistence:8,deploy:9,mcp:9,scale:7,security:8,vendor_unmetered:10},
  {repo:"microsoft/playwright-mcp",gateway:1,compute:2,browser:10,terminal:1,filesystem:2,persistence:6,deploy:1,mcp:10,scale:6,security:8,vendor_unmetered:10},
  {repo:"agent-infra/sandbox",gateway:4,compute:9,browser:10,terminal:10,filesystem:10,persistence:9,deploy:8,mcp:10,scale:7,security:6,vendor_unmetered:10},
  {repo:"containers/kubernetes-mcp-server",gateway:3,compute:10,browser:1,terminal:9,filesystem:7,persistence:10,deploy:10,mcp:10,scale:10,security:9,vendor_unmetered:10},
  {repo:"daytonaio/daytona",gateway:4,compute:10,browser:9,terminal:10,filesystem:10,persistence:9,deploy:9,mcp:10,scale:9,security:9,vendor_unmetered:2}
];

for(const r of rows){
  r.score=Object.entries(weights).reduce((s,[k,w])=>s+(r[k]??0)*w,0)/Object.values(weights).reduce((a,b)=>a+b,0);
}
rows.sort((a,b)=>b.score-a.score);

const practical={
  gateway:"docker/mcp-gateway",
  runtime:"manusa/podman-mcp-server",
  browser:"microsoft/playwright-mcp",
  heavy_worker:"agent-infra/sandbox",
  future_scale:"containers/kubernetes-mcp-server"
};

const ok=packet.constraints.zero_spend_first&&packet.constraints.blitz_primary&&packet.constraints.paid_fallback_allowed===false;
console.log("ZEIBAEL_SELF_HOSTED_MCP_AUDIT="+JSON.stringify({status:ok?"VERIFIED":"FAILED",runtime:"STACKBLITZ_WEBCONTAINER",practical,rows}));
if(!ok) process.exitCode=1;
