#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = path.join(ROOT, "scripts", "blitz-mcp-accelerator-canary.mcp.json");
const INSPECTOR = "@modelcontextprotocol/inspector@2.0.0";

function runInspector(extra) {
  const args = [
    "--yes",
    INSPECTOR,
    "--cli",
    "--config",
    CONFIG,
    "--server",
    "chrome-devtools",
    ...extra,
    "--format",
    "json",
  ];
  const cp = spawnSync("npx", args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 180_000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CI: "1",
      NO_COLOR: "1",
      CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
      CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
    },
  });
  if (cp.error) throw cp.error;
  if (cp.status !== 0) {
    throw new Error(`inspector exit=${cp.status} stderr=${(cp.stderr || "").slice(-4000)} stdout=${(cp.stdout || "").slice(-4000)}`);
  }
  const raw = (cp.stdout || "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error(`non-json inspector output: ${raw.slice(-4000)}`);
  }
}

function toolNames(obj) {
  const candidates = [
    obj?.result?.tools,
    obj?.tools,
    obj?.result?.result?.tools,
  ];
  for (const value of candidates) {
    if (Array.isArray(value)) return value.map((x) => x?.name).filter(Boolean);
  }
  return [];
}

async function remoteProbe(name, url) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2026-07-28",
      capabilities: {},
      clientInfo: { name: "zeibael-blitz-public-canary", version: "1.0.0" },
    },
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      redirect: "follow",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    const challenge = res.headers.get("www-authenticate") || "";
    const contentType = res.headers.get("content-type") || "";
    const authRequired = [401, 403].includes(res.status);
    const initialized = res.status === 200 && (
      text.includes('"jsonrpc"') ||
      text.includes('"serverInfo"') ||
      contentType.includes("text/event-stream")
    );
    const authEvidence = authRequired && (
      challenge.toLowerCase().includes("bearer") ||
      challenge.toLowerCase().includes("oauth") ||
      text.toLowerCase().includes("oauth") ||
      text.toLowerCase().includes("authorization")
    );
    if (!(initialized || authEvidence)) {
      throw new Error(`${name} unexpected status=${res.status} challenge=${challenge} body=${text.slice(0, 1200)}`);
    }
    return {
      status: "PASS",
      endpoint: url,
      http_status: res.status,
      mode: initialized ? "INITIALIZED_NO_AUTH" : "AUTH_REQUIRED_EXPECTED",
      challenge_present: Boolean(challenge),
      content_type: contentType,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const evidence = {
    schema: "zeibael.blitz_mcp_accelerator_public_canary.v1",
    timestamp: new Date().toISOString(),
    zero_spend: true,
    secrets_used: false,
    live_order_enabled: false,
    checks: {},
  };

  const inventory = runInspector(["--method", "tools/list"]);
  const names = toolNames(inventory);
  const required = {
    list_pages: names.includes("list_pages"),
    performance: names.some((x) => x.includes("performance")),
    network: names.some((x) => x.includes("network")),
  };
  if (!required.list_pages || !required.performance || !required.network) {
    throw new Error(`chrome-devtools tool inventory missing required groups: ${JSON.stringify({ required, names })}`);
  }
  evidence.checks.inspector_cli = {
    status: "PASS",
    package: INSPECTOR,
    mode: "CLI",
  };
  evidence.checks.chrome_devtools_mcp = {
    status: "PASS",
    package: "chrome-devtools-mcp@1.9.0",
    tool_count: names.length,
    required_groups: required,
    privacy_flags: [
      "--no-usage-statistics",
      "--no-performance-crux",
      "--no-javascript-evaluation",
    ],
  };

  const pages = runInspector([
    "--method", "tools/call",
    "--tool-name", "list_pages",
    "--tool-args-json", "{}",
  ]);
  evidence.checks.chrome_browser_launch = {
    status: "PASS",
    call: "list_pages",
    result_present: Boolean(pages?.result || pages?.content),
  };

  const endpoints = {
    cloudflare_api: "https://mcp.cloudflare.com/mcp",
    cloudflare_builds: "https://builds.mcp.cloudflare.com/mcp",
    cloudflare_observability: "https://observability.mcp.cloudflare.com/mcp",
    upstash_accelerator: "https://mcp.upstash.com/mcp?features=redis,qstash_workflow",
  };
  for (const [name, url] of Object.entries(endpoints)) {
    evidence.checks[name] = await remoteProbe(name, url);
  }

  evidence.status = "VERIFIED";
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({
    schema: "zeibael.blitz_mcp_accelerator_public_canary.v1",
    status: "FAILED",
    zero_spend: true,
    live_order_enabled: false,
    error: String(err?.stack || err),
  }, null, 2));
  process.exit(1);
});
