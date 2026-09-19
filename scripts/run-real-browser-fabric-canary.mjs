import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const PORT = 4174;
const DEBUG_PORT = 9223;
const API_VERSION = "1.6.4";
const FIXTURE = "fixtures/browser-fabric-v19.html";
const EVIDENCE = "evidence/browser-fabric-real-host.json";
const LIVE_EDGE_URL = "https://pfxcdxxxcyoinlksruoy.supabase.co/functions/v1/zeibael-stackblitz-direct?lane=stackblitz-compute-v1";
const PRIVATE_SOURCE_COMMIT = "370c53438957bb26dde6e36b13b7d9be54f43250";
const PRIVATE_SOURCE_BLOB = "d06cfc4f97d7eaf691efd1d42f278eae8bbe1d79";

const html = await readFile(FIXTURE, "utf8");
const fixtureSha256 = createHash("sha256").update(html, "utf8").digest("hex");

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

async function browserCanary() {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  let stage = "initial";
  try {
    const initial = window.zeibaelProbe();
    stage = "watch";
    const watchStart = await window.zeibaelWatch({ path: "/", recursive: true });

  stage = "cold-run";
  const fsCode = 'console.log("watch-trigger")';
  const writeRun = await window.zeibaelRun({
    tasks: [{ id: "fs-write", code: fsCode, cache_safe: false, kernel_safe: false }],
    concurrency: 1,
  });
  await wait(500);
  const watchEvents = window.zeibaelEvents().filter(x => x && x.type === "fs_change");
  stage = "export-digest";
  const exportDigest = await window.zeibaelExportDigest({ path: "/", format: "json" });

  stage = "snapshot-first";
  const first = await window.zeibaelRun({
    tasks: [{ id: "snapshot-first", code: "console.log(21*2)", cache_safe: false, kernel_safe: true }],
    concurrency: 1,
  });
  const afterFirst = window.zeibaelProbe();

  stage = "broker";
  const broker = await window.zeibaelRunEnvelope({
    schema: "zeibael.blitz.route.v2",
    provider_key: "linear",
    capability_key: "AGENT_COCKPIT",
    execution_class: "CONNECTOR_BROKERED",
    broker_required: true,
    canonical_state: "SUPABASE",
    credential_exposure_allowed: false,
    live_order_enabled: false,
    tasks: [],
  });

  let liveOrderRejected = false;
  try {
    await window.zeibaelRunEnvelope({
      schema: "zeibael.blitz.route.v2",
      execution_class: "LOCAL_BLITZ",
      broker_required: false,
      canonical_state: "SUPABASE",
      credential_exposure_allowed: false,
      live_order_enabled: true,
      tasks: [],
    });
  } catch (e) {
    liveOrderRejected = String(e?.message || e).includes("live_order_forbidden");
  }

  let credentialExposureRejected = false;
  try {
    await window.zeibaelRunEnvelope({
      schema: "zeibael.blitz.route.v2",
      execution_class: "LOCAL_BLITZ",
      broker_required: false,
      canonical_state: "SUPABASE",
      credential_exposure_allowed: true,
      live_order_enabled: false,
      tasks: [],
    });
  } catch (e) {
    credentialExposureRejected = String(e?.message || e).includes("credential_exposure_forbidden");
  }

  stage = "reset";
  window.zeibaelStopWatch();
  await window.zeibaelResetRuntime();

  stage = "snapshot-second";
  const second = await window.zeibaelRun({
    tasks: [{ id: "snapshot-second", code: "console.log(6*7)", cache_safe: false, kernel_safe: true }],
    concurrency: 1,
  });
  const afterSecond = window.zeibaelProbe();

  const ok =
    initial.max_concurrency === 57 &&
    watchStart?.ok === true &&
    writeRun?.ok === true &&
    watchEvents.length >= 1 &&
    exportDigest?.ok === true &&
    Number(exportDigest?.bytes) >= 1 &&
    /^[0-9a-f]{64}$/.test(String(exportDigest?.sha256 || "")) &&
    first?.ok === true &&
    Number(afterFirst?.snapshot_misses) >= 1 &&
    Number(afterFirst?.snapshot_writes) >= 1 &&
    second?.ok === true &&
    Number(afterSecond?.snapshot_hits) >= 1 &&
    broker?.status === "BROKER_REQUIRED" &&
    broker?.executed === false &&
    liveOrderRejected === true &&
    credentialExposureRejected === true;

  return {
    ok,
    stage: "complete",
    probe: initial,
    snapshot: { after_first: afterFirst, after_second: afterSecond },
    watch: {
      ok: watchStart?.ok === true && watchEvents.length >= 1,
      fs_change_events: watchEvents.length,
      latest: watchEvents.slice(-8),
      write_run_ok: writeRun?.ok === true,
    },
    export_digest: exportDigest,
    broker,
    live_order_rejected: liveOrderRejected,
    credential_exposure_rejected: credentialExposureRejected,
    first_run_ok: first?.ok === true,
    second_run_ok: second?.ok === true,
  };
  } catch (e) {
    throw new Error("BROWSER_FABRIC_STAGE_" + stage + ":" + String(e?.message || e));
  }
}

await mkdir("evidence", { recursive: true });
let liveEdgeStatus = 0;
let liveEdgeSha256 = "";
let liveEdgeFixtureExactMatch = false;
try {
  const edge = await fetch(LIVE_EDGE_URL, { headers: { accept: "text/html,*/*" } });
  liveEdgeStatus = edge.status;
  const edgeBody = await edge.text();
  liveEdgeSha256 = createHash("sha256").update(edgeBody, "utf8").digest("hex");
  liveEdgeFixtureExactMatch = edgeBody === html;
} catch {}

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
  "--user-data-dir=/tmp/zeibael-browser-fabric-" + process.pid,
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

  const readyStarted = Date.now();
  let ready = false;
  let lastState = null;
  while (Date.now() - readyStarted < 30000) {
    const r = await cdp.send("Runtime.evaluate", {
      expression: 'JSON.stringify({ready:typeof window.zeibaelProbe==="function"&&typeof window.zeibaelWatch==="function"&&typeof window.zeibaelRun==="function"&&typeof window.zeibaelExportDigest==="function"&&typeof window.zeibaelRunEnvelope==="function"&&typeof window.zeibaelResetRuntime==="function",status:document.getElementById("status")?.textContent||null,coi:self.crossOriginIsolated,sab:typeof SharedArrayBuffer,apis:{watch:typeof window.zeibaelWatch,run:typeof window.zeibaelRun,exportDigest:typeof window.zeibaelExportDigest,envelope:typeof window.zeibaelRunEnvelope,reset:typeof window.zeibaelResetRuntime}})',
      returnByValue: true,
    });
    if (typeof r?.result?.value === "string") {
      lastState = JSON.parse(r.result.value);
      if (lastState.ready === true && lastState.coi === true && lastState.sab === "function") { ready = true; break; }
    }
    await sleep(250);
  }
  if (!ready) throw new Error("BROWSER_FABRIC_NOT_READY:" + JSON.stringify(lastState));

  const evaluated = await cdp.send("Runtime.evaluate", {
    expression: "(" + browserCanary.toString() + ")()",
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluated?.exceptionDetails) throw new Error("BROWSER_CANARY_EXCEPTION:" + JSON.stringify(evaluated.exceptionDetails));
  const result = evaluated?.result?.value;
  if (!result || typeof result !== "object") throw new Error("BROWSER_CANARY_RESULT_INVALID");

  const evidence = {
    schema: "zeibael.blitz.browser-fabric-real-host-canary.v1",
    ok: result.ok === true && liveEdgeStatus === 200 && /^[0-9a-f]{64}$/.test(liveEdgeSha256),
    runtime: "STACKBLITZ_WEBCONTAINER_BROWSER_FABRIC",
    webcontainer_api_version: API_VERSION,
    cross_origin_isolated: true,
    shared_array_buffer: "function",
    canonical_state: "SUPABASE",
    live_order_enabled: false,
    private_source_commit: PRIVATE_SOURCE_COMMIT,
    private_source_blob: PRIVATE_SOURCE_BLOB,
    fixture_sha256: fixtureSha256,
    live_edge_http_status: liveEdgeStatus,
    live_edge_html_sha256: liveEdgeSha256,
    live_edge_fixture_exact_match: liveEdgeFixtureExactMatch,
    ...result,
  };
  await writeFile(EVIDENCE, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  process.stdout.write("ZEIBAEL_BROWSER_FABRIC_CANARY=" + JSON.stringify(evidence) + "\n");
  if (evidence.ok !== true) process.exitCode = 1;
} catch (error) {
  const evidence = {
    schema: "zeibael.blitz.browser-fabric-real-host-canary.v1",
    ok: false,
    runtime: "STACKBLITZ_WEBCONTAINER_BROWSER_FABRIC",
    webcontainer_api_version: API_VERSION,
    error: String(error?.stack || error),
    chrome_stderr: chromeErr.slice(-6000),
    canonical_state: "SUPABASE",
    live_order_enabled: false,
    private_source_commit: PRIVATE_SOURCE_COMMIT,
    private_source_blob: PRIVATE_SOURCE_BLOB,
    fixture_sha256: fixtureSha256,
    live_edge_http_status: liveEdgeStatus,
    live_edge_html_sha256: liveEdgeSha256,
    live_edge_fixture_exact_match: liveEdgeFixtureExactMatch,
  };
  await writeFile(EVIDENCE, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  console.error("ZEIBAEL_BROWSER_FABRIC_CANARY=" + JSON.stringify(evidence));
  process.exitCode = 1;
} finally {
  cdp?.close();
  try { chrome.kill("SIGKILL"); } catch {}
  await new Promise(resolve => server.close(resolve));
}
