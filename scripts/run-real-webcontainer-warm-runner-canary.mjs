import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const PORT = 4173;
const DEBUG_PORT = 9222;
const API_VERSION = "1.6.4";
const evidencePath = "evidence/warm-runner-real-webcontainer.json";

const sources = {
  warmKernel: await readFile("src/warm-kernel.mjs", "utf8"),
  blitzCache: await readFile("src/blitz-cache.mjs", "utf8"),
  warmRunner: await readFile("services/warm-runner/server.mjs", "utf8"),
  probe: await readFile("services/warm-runner/canary-probe.mjs", "utf8"),
};

const tree = {
  src: { directory: {
    "warm-kernel.mjs": { file: { contents: sources.warmKernel } },
    "blitz-cache.mjs": { file: { contents: sources.blitzCache } },
  }},
  services: { directory: {
    "warm-runner": { directory: {
      "server.mjs": { file: { contents: sources.warmRunner } },
      "canary-probe.mjs": { file: { contents: sources.probe } },
    }},
  }},
};

const html = `<!doctype html>
<meta charset="utf-8">
<title>ZEIBAEL Warm Runner Real WebContainer Canary</title>
<pre id="status">BOOTING</pre>
<pre id="result"></pre>
<script>
window.__zeibaelPageErrors=[];
addEventListener("error",e=>window.__zeibaelPageErrors.push({type:"error",message:String(e.message||e.error||"unknown"),filename:e.filename||null,lineno:e.lineno||null}));
addEventListener("unhandledrejection",e=>window.__zeibaelPageErrors.push({type:"unhandledrejection",message:String(e.reason?.stack||e.reason||"unknown")}));
</script>
<script type="module">
const status = document.getElementById("status");
const result = document.getElementById("result");
const tree = ${JSON.stringify(tree)};
async function collect(proc) {
  let out = "";
  const reader = proc.output.getReader();
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    out += item.value;
    if (out.length > 200000) out = out.slice(-200000);
  }
  return out;
}
async function main() {
  let wc;
  try {
    if (!self.crossOriginIsolated || typeof SharedArrayBuffer !== "function") {
      throw new Error("CROSS_ORIGIN_ISOLATION_REQUIRED");
    }
    status.textContent = "IMPORTING_WEBCONTAINER_API";
    let WebContainer = null;
    let importError = null;
    for (const url of [
      "https://esm.sh/@webcontainer/api@${API_VERSION}",
      "https://cdn.jsdelivr.net/npm/@webcontainer/api@${API_VERSION}/+esm"
    ]) {
      try {
        const mod = await Promise.race([
          import(url),
          new Promise((_, reject) => setTimeout(() => reject(new Error("IMPORT_TIMEOUT:" + url)), 10000))
        ]);
        if (typeof mod?.WebContainer === "function") { WebContainer = mod.WebContainer; break; }
      } catch (e) { importError = String(e?.message || e); }
    }
    if (!WebContainer) throw new Error("WEBCONTAINER_API_IMPORT_FAILED:" + String(importError || "unknown"));
    status.textContent = "WEBCONTAINER_BOOT";
    wc = await WebContainer.boot({ coep: "credentialless" });
    status.textContent = "MOUNTING";
    await wc.mount(tree);

    const nodeProc = await wc.spawn("node", ["-e", "console.log(JSON.stringify({version:process.version,platform:process.platform,arch:process.arch}))"]);
    const nodeOut = await collect(nodeProc);
    const nodeExit = await nodeProc.exit;
    if (nodeExit !== 0) throw new Error("NODE_PROBE_FAILED");
    const node = JSON.parse(nodeOut.trim());

    status.textContent = "WARM_RUNNER_SERVER";
    const runner = await wc.spawn(
      "node",
      ["services/warm-runner/server.mjs"],
      {
        env: {
          PORT: "19091",
          ZEIBAEL_BURST_TOKEN: "selftest-token",
          NODE_ENV: "production",
          ZEIBAEL_LIVE_ORDER_ENABLED: "false"
        },
        output: false
      }
    );
    let warm;
    let probeExit = 1;
    try {
      status.textContent = "WARM_RUNNER_PROBE";
      const proc = await wc.spawn(
        "node",
        ["services/warm-runner/canary-probe.mjs"],
        { env: { PORT: "19091", ZEIBAEL_BURST_TOKEN: "selftest-token" } }
      );
      const probeResult = await Promise.race([
        (async()=>({ output: await collect(proc), exit: await proc.exit }))(),
        new Promise((_,reject)=>setTimeout(()=>reject(new Error("WARM_RUNNER_PROBE_TIMEOUT_30S")),30000))
      ]);
      const output = probeResult.output;
      probeExit = probeResult.exit;
      const marker = output.split(/\\r?\\n/).find(line => line.startsWith("BLITZ_WARM_RUNNER_SELFTEST="));
      if (!marker) throw new Error("WARM_RUNNER_SENTINEL_MISSING:" + output.slice(-4000));
      warm = JSON.parse(marker.slice("BLITZ_WARM_RUNNER_SELFTEST=".length));
    } finally {
      try { runner.kill(); } catch {}
    }
    const evidence = {
      schema: "zeibael.blitz.webcontainer-warm-runner-canary.v1",
      ok: probeExit === 0 && warm.ok === true,
      runtime: "STACKBLITZ_WEBCONTAINER",
      webcontainer_api_version: "${API_VERSION}",
      cross_origin_isolated: self.crossOriginIsolated,
      shared_array_buffer: typeof SharedArrayBuffer,
      node,
      warm_runner: warm,
      canonical_state: "SUPABASE",
      live_order_enabled: false,
    };
    result.textContent = JSON.stringify(evidence);
    status.textContent = evidence.ok ? "PASS" : "FAIL";
  } catch (error) {
    result.textContent = JSON.stringify({
      schema: "zeibael.blitz.webcontainer-warm-runner-canary.v1",
      ok: false,
      runtime: "STACKBLITZ_WEBCONTAINER",
      webcontainer_api_version: "${API_VERSION}",
      cross_origin_isolated: self.crossOriginIsolated,
      shared_array_buffer: typeof SharedArrayBuffer,
      error: String(error?.stack || error),
      canonical_state: "SUPABASE",
      live_order_enabled: false,
    });
    status.textContent = "ERROR";
  } finally {
    try { wc?.teardown(); } catch {}
  }
}
main();
</script>`;

const server = http.createServer((req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
  if (req.url === "/" || req.url === "/index.html") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
  } else {
    res.statusCode = 404;
    res.end("not found");
  }
});

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const r = spawnSync("which", [name], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  throw new Error("CHROME_NOT_FOUND");
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitJson(url, timeoutMs = 15000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      last = new Error("HTTP_" + r.status);
    } catch (e) { last = e; }
    await sleep(100);
  }
  throw last || new Error("TIMEOUT:" + url);
}
function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  ws.addEventListener("message", event => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (!msg.id) return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  });
  return {
    async send(method, params = {}) {
      await opened;
      const id = ++seq;
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { try { ws.close(); } catch {} },
  };
}

await mkdir("evidence", { recursive: true });
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(PORT, "127.0.0.1", resolve);
});

const chrome = spawn(chromePath(), [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-features=TrackingProtection3pcd,ThirdPartyStoragePartitioning,ThirdPartyCookiesDeprecation,BlockThirdPartyCookies",
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=" + DEBUG_PORT,
  "--user-data-dir=/tmp/zeibael-chrome-" + process.pid,
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

let chromeErr = "";
chrome.stderr.on("data", d => {
  chromeErr += d.toString();
  if (chromeErr.length > 20000) chromeErr = chromeErr.slice(-20000);
});

let cdp;
try {
  await waitJson("http://127.0.0.1:" + DEBUG_PORT + "/json/version", 20000);
  const targetUrl = "http://127.0.0.1:" + PORT + "/";
  const targetResp = await fetch("http://127.0.0.1:" + DEBUG_PORT + "/json/new?" + encodeURIComponent(targetUrl), { method: "PUT" });
  if (!targetResp.ok) throw new Error("CDP_NEW_TARGET_HTTP_" + targetResp.status);
  const target = await targetResp.json();
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  const started = Date.now();
  let evidence = null;
  let lastState = null;
  while (Date.now() - started < 150000) {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `JSON.stringify({
        href:location.href,
        readyState:document.readyState,
        title:document.title,
        contentType:document.contentType,
        status:document.getElementById("status")?.textContent||null,
        result:document.getElementById("result")?.textContent||"",
        coi:self.crossOriginIsolated,
        sab:typeof SharedArrayBuffer,
        cookieEnabled:navigator.cookieEnabled,
        serviceWorker:("serviceWorker" in navigator),
        errors:window.__zeibaelPageErrors||[]
      })`,
      returnByValue: true,
    });
    const rawState = r?.result?.value;
    if (typeof rawState === "string") {
      try { lastState = JSON.parse(rawState); } catch {}
    }
    const value = lastState?.result;
    if (typeof value === "string" && value.startsWith("{")) {
      evidence = JSON.parse(value);
      if (evidence.ok === true || evidence.error) break;
    }
    await sleep(500);
  }
  if (!evidence) {
    const err = new Error("CANARY_RESULT_TIMEOUT");
    err.diagnostic = lastState;
    throw err;
  }
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  process.stdout.write("ZEIBAEL_REAL_WEBCONTAINER_CANARY=" + JSON.stringify(evidence) + "\n");
  if (evidence.ok !== true) process.exitCode = 1;
} catch (error) {
  const evidence = {
    schema: "zeibael.blitz.webcontainer-warm-runner-canary.v1",
    ok: false,
    runtime: "STACKBLITZ_WEBCONTAINER",
    webcontainer_api_version: API_VERSION,
    error: String(error?.stack || error),
    diagnostic: error?.diagnostic || null,
    chrome_stderr: chromeErr.slice(-6000),
    canonical_state: "SUPABASE",
    live_order_enabled: false,
  };
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  console.error("ZEIBAEL_REAL_WEBCONTAINER_CANARY=" + JSON.stringify(evidence));
  process.exitCode = 1;
} finally {
  cdp?.close();
  try { chrome.kill("SIGKILL"); } catch {}
  await new Promise(resolve => server.close(resolve));
}
