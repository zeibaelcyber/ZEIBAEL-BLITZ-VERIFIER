import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

const PORT = 4173;
const DEBUG_PORT = 9222;
const evidencePath = "evidence/warm-runner-real-webcontainer.json";
const commit = String(process.env.GITHUB_SHA || "");

if (!/^[0-9a-f]{40}$/.test(commit)) {
  throw new Error("INVALID_GITHUB_SHA");
}

const stackblitzUrl =
  "https://stackblitz.com/github/zeibaelcyber/ZEIBAEL-BLITZ-VERIFIER/tree/" +
  commit +
  "?embed=1&ctl=0&startScript=warm-runner%3Asentinel&view=editor&terminalHeight=0&hideNavigation=1";

const pageScript = [
  'const status=document.getElementById("status");',
  'const result=document.getElementById("result");',
  'const frame=document.getElementById("stackblitz");',
  'window.__zeibaelPageErrors=[];',
  'addEventListener("error",e=>window.__zeibaelPageErrors.push({type:"error",message:String(e.message||e.error||"unknown")}));',
  'addEventListener("unhandledrejection",e=>window.__zeibaelPageErrors.push({type:"unhandledrejection",message:String(e.reason?.stack||e.reason||"unknown")}));',
  'const sleep=ms=>new Promise(r=>setTimeout(r,ms));',
  'async function connectVm(){',
  '  const started=Date.now(); let last=null;',
  '  while(Date.now()-started<90000){',
  '    try{',
  '      if(!window.StackBlitzSDK) throw new Error("STACKBLITZ_SDK_NOT_READY");',
  '      const vm=await window.StackBlitzSDK.connect(frame);',
  '      await vm.getDependencies();',
  '      return vm;',
  '    }catch(e){last=e;await sleep(1000)}',
  '  }',
  '  throw last||new Error("STACKBLITZ_VM_CONNECT_TIMEOUT");',
  '}',
  'async function main(){',
  '  try{',
  '    status.textContent="WAITING_STACKBLITZ_IFRAME";',
  '    await Promise.race([',
  '      new Promise(resolve=>frame.addEventListener("load",resolve,{once:true})),',
  '      sleep(8000)',
  '    ]);',
  '    status.textContent="CONNECTING_STACKBLITZ_VM";',
  '    const vm=await connectVm();',
  '    status.textContent="POLLING_STACKBLITZ_FS";',
  '    const started=Date.now(); let lastError=null; let snapshots=0;',
  '    while(Date.now()-started<240000){',
  '      try{',
  '        const files=await vm.getFsSnapshot(); snapshots++;',
  '        const raw=files["evidence/warm-runner-real-webcontainer.json"];',
  '        if(typeof raw==="string"&&raw.trim().startsWith("{")){',
  '          const evidence=JSON.parse(raw);',
  '          result.textContent=JSON.stringify({evidence,snapshots});',
  '          status.textContent=evidence.ok===true?"PASS":"FAIL";',
  '          return;',
  '        }',
  '      }catch(e){lastError=String(e?.stack||e)}',
  '      await sleep(1500);',
  '    }',
  '    throw new Error("STACKBLITZ_EVIDENCE_TIMEOUT:"+String(lastError||"no_evidence_file"));',
  '  }catch(e){',
  '    result.textContent=JSON.stringify({error:String(e?.stack||e)});',
  '    status.textContent="ERROR";',
  '  }',
  '}',
  'main();'
].join("\n");

const html = [
  "<!doctype html>",
  '<meta charset="utf-8">',
  "<title>ZEIBAEL Hosted StackBlitz Warm Runner Canary</title>",
  '<pre id="status">BOOTING</pre>',
  '<pre id="result"></pre>',
  '<iframe id="stackblitz" allow="cross-origin-isolated" style="width:1280px;height:720px;border:0" src="' +
    stackblitzUrl.replaceAll("&", "&amp;") +
    '"></iframe>',
  '<script src="https://unpkg.com/@stackblitz/sdk@1/bundles/sdk.umd.js"></script>',
  "<script>" + pageScript + "</script>",
].join("\n");

const server = http.createServer((req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitJson(url, timeoutMs = 15000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      last = new Error("HTTP_" + r.status);
    } catch (error) {
      last = error;
    }
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
  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
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
    close() {
      try {
        ws.close();
      } catch {}
    },
  };
}

await mkdir("evidence", { recursive: true });
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(PORT, "127.0.0.1", resolve);
});

const chrome = spawn(
  chromePath(),
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-features=TrackingProtection3pcd,ThirdPartyStoragePartitioning,ThirdPartyCookiesDeprecation,BlockThirdPartyCookies",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=" + DEBUG_PORT,
    "--user-data-dir=/tmp/zeibael-stackblitz-hosted-" + process.pid,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

let chromeErr = "";
chrome.stderr.on("data", (chunk) => {
  chromeErr += chunk.toString();
  if (chromeErr.length > 20000) chromeErr = chromeErr.slice(-20000);
});

let cdp;
try {
  await waitJson("http://127.0.0.1:" + DEBUG_PORT + "/json/version", 20000);
  const targetUrl = "http://127.0.0.1:" + PORT + "/";
  const targetResp = await fetch(
    "http://127.0.0.1:" + DEBUG_PORT + "/json/new?" + encodeURIComponent(targetUrl),
    { method: "PUT" },
  );
  if (!targetResp.ok) throw new Error("CDP_NEW_TARGET_HTTP_" + targetResp.status);
  const target = await targetResp.json();
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  const started = Date.now();
  let lastState = null;
  let payload = null;
  while (Date.now() - started < 300000) {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `JSON.stringify({
        href:location.href,
        readyState:document.readyState,
        status:document.getElementById("status")?.textContent||null,
        result:document.getElementById("result")?.textContent||"",
        sdk:typeof window.StackBlitzSDK,
        errors:window.__zeibaelPageErrors||[]
      })`,
      returnByValue: true,
    });
    const raw = r?.result?.value;
    if (typeof raw === "string") {
      try {
        lastState = JSON.parse(raw);
      } catch {}
    }
    if (typeof lastState?.result === "string" && lastState.result.startsWith("{")) {
      try {
        payload = JSON.parse(lastState.result);
      } catch {}
      if (payload?.evidence || payload?.error) break;
    }
    await sleep(1000);
  }

  if (!payload?.evidence) {
    const error = new Error("HOSTED_STACKBLITZ_CANARY_TIMEOUT");
    error.diagnostic = { lastState, payload };
    throw error;
  }

  const evidence = {
    ...payload.evidence,
    harness: "STACKBLITZ_HOSTED_GITHUB_IFRAME_SDK_VM",
    pinned_commit: commit,
    stackblitz_project: stackblitzUrl,
    vm_snapshots: payload.snapshots ?? null,
  };

  if (
    evidence.ok !== true ||
    evidence.runtime !== "STACKBLITZ_WEBCONTAINER" ||
    evidence.canonical_state !== "SUPABASE" ||
    evidence.live_order_enabled !== false
  ) {
    const error = new Error("HOSTED_STACKBLITZ_EVIDENCE_INVALID");
    error.diagnostic = evidence;
    throw error;
  }

  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  process.stdout.write(
    "ZEIBAEL_REAL_WEBCONTAINER_CANARY=" +
      JSON.stringify({
        ok: true,
        schema: evidence.schema,
        runtime: evidence.runtime,
        harness: evidence.harness,
        pinned_commit: evidence.pinned_commit,
        node: evidence.node,
        warm_runner_schema: evidence.warm_runner?.schema ?? null,
        pid_reused: evidence.warm_runner?.pid_reused ?? null,
        cache_hits: evidence.warm_runner?.second?.cache?.hits ?? null,
        broker_status: evidence.warm_runner?.broker?.status ?? null,
        live_order_enabled: false,
      }) +
      "\n",
  );
} catch (error) {
  const evidence = {
    schema: "zeibael.blitz.webcontainer-warm-runner-canary.v2",
    ok: false,
    runtime: "STACKBLITZ_WEBCONTAINER",
    harness: "STACKBLITZ_HOSTED_GITHUB_IFRAME_SDK_VM",
    pinned_commit: commit,
    stackblitz_project: stackblitzUrl,
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
  try {
    chrome.kill("SIGKILL");
  } catch {}
  await new Promise((resolve) => server.close(resolve));
}
