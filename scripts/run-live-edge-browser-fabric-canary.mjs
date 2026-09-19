import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

const PORT=4174;
const DEBUG_PORT=9223;
const API_VERSION="1.6.4";
const evidencePath="evidence/browser-fabric-real-host.json";
const LIVE_EDGE_URL="https://pfxcdxxxcyoinlksruoy.supabase.co/functions/v1/zeibael-stackblitz-direct?lane=stackblitz-compute-v1";

function chromePath(){
  if(process.env.CHROME_PATH)return process.env.CHROME_PATH;
  for(const name of ["google-chrome","google-chrome-stable","chromium","chromium-browser"]){
    const r=spawnSync("which",[name],{encoding:"utf8"});
    if(r.status===0&&r.stdout.trim())return r.stdout.trim();
  }
  throw new Error("CHROME_NOT_FOUND");
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitJson(url,timeoutMs=15000){
  const started=Date.now();let last;
  while(Date.now()-started<timeoutMs){
    try{const r=await fetch(url);if(r.ok)return await r.json();last=new Error("HTTP_"+r.status)}
    catch(e){last=e}
    await sleep(100);
  }
  throw last||new Error("TIMEOUT:"+url);
}
function connectCdp(wsUrl){
  const ws=new WebSocket(wsUrl);let seq=0;
  const pending=new Map();
  const opened=new Promise((resolve,reject)=>{
    ws.addEventListener("open",resolve,{once:true});
    ws.addEventListener("error",reject,{once:true});
  });
  ws.addEventListener("message",event=>{
    let msg;try{msg=JSON.parse(event.data)}catch{return}
    if(!msg.id)return;
    const p=pending.get(msg.id);if(!p)return;
    pending.delete(msg.id);
    if(msg.error)p.reject(new Error(JSON.stringify(msg.error)));else p.resolve(msg.result);
  });
  return {
    async send(method,params={}){
      await opened;const id=++seq;
      return await new Promise((resolve,reject)=>{
        pending.set(id,{resolve,reject});
        ws.send(JSON.stringify({id,method,params}));
      });
    },
    close(){try{ws.close()}catch{}}
  };
}

await mkdir("evidence",{recursive:true});
const liveResp=await fetch(LIVE_EDGE_URL+"&canary="+Date.now(),{
  headers:{accept:"text/html,*/*","cache-control":"no-cache"}
});
const liveHtml=await liveResp.text();
const liveContentType=liveResp.headers.get("content-type")||"";
if(!liveResp.ok)throw new Error("LIVE_EDGE_HTTP_"+liveResp.status);
if(!liveHtml.includes("ZEIBAEL Blitz Free Fabric v2")||!liveHtml.includes("window.zeibaelExportDigest")||!liveHtml.includes("window.zeibaelWatch")){
  throw new Error("LIVE_EDGE_BODY_FEATURES_MISSING");
}
const liveHtmlSha256=crypto.createHash("sha256").update(liveHtml).digest("hex");

const server=http.createServer((req,res)=>{
  res.setHeader("Cross-Origin-Opener-Policy","same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy","credentialless");
  res.setHeader("Cross-Origin-Resource-Policy","same-origin");
  res.setHeader("Cache-Control","no-store");
  if(req.url==="/"||req.url==="/index.html"){
    res.statusCode=200;
    res.setHeader("Content-Type","text/html; charset=utf-8");
    res.end(liveHtml);
  }else{res.statusCode=404;res.end("not found")}
});
await new Promise((resolve,reject)=>{
  server.once("error",reject);
  server.listen(PORT,"127.0.0.1",resolve);
});

const chrome=spawn(chromePath(),[
  "--headless=new","--no-sandbox","--disable-gpu","--disable-dev-shm-usage",
  "--disable-features=TrackingProtection3pcd,ThirdPartyStoragePartitioning,ThirdPartyCookiesDeprecation,BlockThirdPartyCookies",
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port="+DEBUG_PORT,
  "--user-data-dir=/tmp/zeibael-browser-fabric-"+process.pid,
  "about:blank"
],{stdio:["ignore","ignore","pipe"]});
let chromeErr="";
chrome.stderr.on("data",d=>{chromeErr+=d.toString();if(chromeErr.length>20000)chromeErr=chromeErr.slice(-20000)});

let cdp;
try{
  await waitJson("http://127.0.0.1:"+DEBUG_PORT+"/json/version",20000);
  const targetUrl="http://127.0.0.1:"+PORT+"/";
  const tr=await fetch("http://127.0.0.1:"+DEBUG_PORT+"/json/new?"+encodeURIComponent(targetUrl),{method:"PUT"});
  if(!tr.ok)throw new Error("CDP_NEW_TARGET_HTTP_"+tr.status);
  const target=await tr.json();
  cdp=connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  const readyStarted=Date.now();let ready=false,lastReady=null;
  while(Date.now()-readyStarted<60000){
    const r=await cdp.send("Runtime.evaluate",{
      expression:`JSON.stringify({ready:typeof window.zeibaelRun==="function"&&typeof window.zeibaelExportDigest==="function"&&typeof window.zeibaelWatch==="function",status:document.getElementById("status")?.textContent||null,coi:self.crossOriginIsolated,sab:typeof SharedArrayBuffer,errors:window.__zeibaelPageErrors||[]})`,
      returnByValue:true
    });
    try{lastReady=JSON.parse(r?.result?.value||"{}")}catch{}
    if(lastReady?.ready===true){ready=true;break}
    await sleep(250);
  }
  if(!ready){const e=new Error("BROWSER_FABRIC_API_NOT_READY");e.diagnostic=lastReady;throw e}

  const expression=`(async()=>{
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const timeout=(p,ms)=>Promise.race([p,new Promise((_,rej)=>setTimeout(()=>rej(new Error("BROWSER_FABRIC_STEP_TIMEOUT")),ms))]);
    return await timeout((async()=>{
      const initial=window.zeibaelProbe();
      await window.zeibaelResetRuntime();

      const first=await window.zeibaelRun({
        tasks:[{id:"snapshot-first",code:"console.log(21*2)",kernel_safe:true,cache_safe:false}],
        concurrency:1
      });
      const afterFirst=window.zeibaelProbe();

      await window.zeibaelResetRuntime();
      const second=await window.zeibaelRun({
        tasks:[{id:"snapshot-second",code:"console.log(6*7)",kernel_safe:true,cache_safe:false}],
        concurrency:1
      });
      const afterSecond=window.zeibaelProbe();

      const watchStart=await window.zeibaelWatch({path:"/zeibael-fabric-canary",recursive:true});
      const write=await window.zeibaelRun({
        tasks:[{
          id:"watch-write",
          code:"import fs from 'node:fs';fs.writeFileSync('/zeibael-fabric-canary/probe.txt','hello');console.log('WATCH_WRITE_OK')",
          kernel_safe:false,
          cache_safe:false
        }],
        concurrency:1
      });
      await sleep(500);
      const events=window.zeibaelEvents();
      const fsChanges=events.filter(x=>x?.type==="fs_change");
      const digest=await window.zeibaelExportDigest({path:"/zeibael-fabric-canary",format:"json"});
      const watchStop=window.zeibaelStopWatch();

      const broker=await window.zeibaelRunEnvelope({
        schema:"zeibael.blitz.route.v2",
        task_id:"browser-fabric-broker",
        provider_key:"github",
        capability_key:"AGENT_COCKPIT",
        execution_class:"CONNECTOR_BROKERED",
        broker_required:true,
        canonical_state:"SUPABASE",
        credential_exposure_allowed:false,
        live_order_enabled:false,
        tasks:[]
      });

      let liveOrderRejected=false;
      try{
        await window.zeibaelRunEnvelope({
          schema:"zeibael.blitz.route.v2",
          execution_class:"LOCAL_BLITZ",
          broker_required:false,
          canonical_state:"SUPABASE",
          credential_exposure_allowed:false,
          live_order_enabled:true,
          tasks:[{id:"forbidden",code:"console.log(1)"}]
        });
      }catch(e){liveOrderRejected=String(e?.message||e).includes("live_order_forbidden")}

      let credentialExposureRejected=false;
      try{
        await window.zeibaelRunEnvelope({
          schema:"zeibael.blitz.route.v2",
          execution_class:"LOCAL_BLITZ",
          broker_required:false,
          canonical_state:"SUPABASE",
          credential_exposure_allowed:true,
          live_order_enabled:false,
          tasks:[{id:"forbidden-secret",code:"console.log(1)"}]
        });
      }catch(e){credentialExposureRejected=String(e?.message||e).includes("credential_exposure_forbidden")}

      const ok=
        initial?.coi===true &&
        initial?.sab==="function" &&
        Number(initial?.max_concurrency)===57 &&
        first?.ok===true &&
        Number(afterFirst?.snapshot_misses)>=1 &&
        Number(afterFirst?.snapshot_writes)>=1 &&
        second?.ok===true &&
        Number(afterSecond?.snapshot_hits)>=1 &&
        watchStart?.ok===true &&
        write?.ok===true &&
        fsChanges.length>=1 &&
        digest?.ok===true &&
        Number(digest?.bytes)>0 &&
        /^[0-9a-f]{64}$/.test(String(digest?.sha256||"")) &&
        watchStop?.ok===true &&
        broker?.status==="BROKER_REQUIRED" &&
        broker?.executed===false &&
        liveOrderRejected===true &&
        credentialExposureRejected===true;

      return {
        ok,
        probe:initial,
        snapshot:{after_first:afterFirst,after_second:afterSecond,first_run_ok:first?.ok===true,second_run_ok:second?.ok===true},
        watch:{ok:watchStart?.ok===true&&write?.ok===true&&fsChanges.length>=1,fs_change_events:fsChanges.length,started:watchStart,stopped:watchStop},
        export_digest:digest,
        broker,
        live_order_rejected:liveOrderRejected,
        credential_exposure_rejected:credentialExposureRejected,
        event_count:events.length
      };
    })(),90000);
  })()`;
  const rr=await cdp.send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});
  if(rr?.exceptionDetails)throw new Error("BROWSER_FABRIC_EVAL_EXCEPTION:"+JSON.stringify(rr.exceptionDetails));
  const browser=rr?.result?.value;
  if(!browser||typeof browser!=="object")throw new Error("BROWSER_FABRIC_RESULT_INVALID");

  const evidence={
    schema:"zeibael.blitz.browser-fabric-real-host-canary.v1",
    ok:browser.ok===true,
    runtime:"STACKBLITZ_WEBCONTAINER_BROWSER_FABRIC",
    webcontainer_api_version:API_VERSION,
    cross_origin_isolated:browser.probe?.coi===true,
    shared_array_buffer:browser.probe?.sab,
    live_edge_url:LIVE_EDGE_URL,
    live_edge_http_status:liveResp.status,
    live_edge_original_content_type:liveContentType,
    live_edge_html_sha256:liveHtmlSha256,
    rehost_content_type:"text/html; charset=utf-8",
    probe:browser.probe,
    snapshot:browser.snapshot,
    watch:browser.watch,
    export_digest:browser.export_digest,
    broker:browser.broker,
    live_order_rejected:browser.live_order_rejected,
    credential_exposure_rejected:browser.credential_exposure_rejected,
    event_count:browser.event_count,
    canonical_state:"SUPABASE",
    live_order_enabled:false
  };
  await writeFile(evidencePath,JSON.stringify(evidence,null,2)+"\n","utf8");
  process.stdout.write("ZEIBAEL_BROWSER_FABRIC_REAL_HOST_CANARY="+JSON.stringify(evidence)+"\n");
  if(evidence.ok!==true)process.exitCode=1;
}catch(error){
  const evidence={
    schema:"zeibael.blitz.browser-fabric-real-host-canary.v1",
    ok:false,
    runtime:"STACKBLITZ_WEBCONTAINER_BROWSER_FABRIC",
    webcontainer_api_version:API_VERSION,
    live_edge_url:LIVE_EDGE_URL,
    live_edge_http_status:liveResp.status,
    live_edge_original_content_type:liveContentType,
    live_edge_html_sha256:liveHtmlSha256,
    error:String(error?.stack||error),
    diagnostic:error?.diagnostic||null,
    chrome_stderr:chromeErr.slice(-6000),
    canonical_state:"SUPABASE",
    live_order_enabled:false
  };
  await writeFile(evidencePath,JSON.stringify(evidence,null,2)+"\n","utf8");
  console.error("ZEIBAEL_BROWSER_FABRIC_REAL_HOST_CANARY="+JSON.stringify(evidence));
  process.exitCode=1;
}finally{
  cdp?.close();
  try{chrome.kill("SIGKILL")}catch{}
  await new Promise(resolve=>server.close(resolve));
}
