import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WC_DIST = path.resolve(__dirname, "../node_modules/@webcontainer/api/dist");

const PORT = 4182;
const STARTUP_TIMEOUT_MS = 45000;
const STEP_TIMEOUT_MS = 30000;
const CANDIDATES = [1,2,4,8,16,24,32,48,64,96,128,192,256,384,512,768,1024,1280,1536,1791];

const html = `<!doctype html><meta charset="utf-8"><title>ZEIBAEL Blitz Adaptive Capacity</title>
<pre id="status">HOST_READY</pre>
<script>window.__classicRan=true;</script>`;

const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url||"/","http://127.0.0.1:"+PORT);
    res.setHeader("cache-control","no-store");
    res.setHeader("Cross-Origin-Opener-Policy","same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy","credentialless");
    res.setHeader("Cross-Origin-Resource-Policy","same-origin");
    if(url.pathname.startsWith("/wc/")){
      const rel=url.pathname.slice("/wc/".length);
      const full=path.resolve(WC_DIST,rel);
      if(!full.startsWith(WC_DIST+path.sep) && full!==path.join(WC_DIST,rel)){
        res.writeHead(403); res.end("forbidden"); return;
      }
      const body=await fs.readFile(full);
      res.setHeader("content-type",rel.endsWith(".js")?"text/javascript; charset=utf-8":"application/octet-stream");
      res.end(body);
      return;
    }
    res.setHeader("content-type","text/html; charset=utf-8");
    res.end(html);
  }catch(e){
    res.writeHead(500,{"content-type":"text/plain; charset=utf-8"});
    res.end(String(e?.message||e));
  }
});
await new Promise(r=>server.listen(PORT,"127.0.0.1",r));

function buildArgs(){
  const blockedExact=new Set(["--disable-site-isolation-trials","--disable-web-security","--single-process"]);
  const blockedFeatures=new Set(["IsolateOrigins","site-per-process","ProcessPerSiteUpToMainFrameThreshold","IsolateSandboxedIframes"]);
  const args=[]; const enable=new Set();
  for(const arg of chromium.args){
    if(blockedExact.has(arg))continue;
    if(arg.startsWith("--disable-features=")){
      const kept=arg.slice("--disable-features=".length).split(",").filter(Boolean).filter(x=>!blockedFeatures.has(x));
      if(kept.length)args.push("--disable-features="+kept.join(","));
      continue;
    }
    if(arg.startsWith("--enable-features=")){
      for(const x of arg.slice("--enable-features=".length).split(","))if(x)enable.add(x);
      continue;
    }
    args.push(arg);
  }
  enable.add("SharedArrayBuffer");
  enable.add("SiteIsolationForCrossOriginOpenerPolicy");
  args.push("--enable-features="+[...enable].join(","));
  args.push("--site-per-process","--isolate-origins=http://127.0.0.1:"+PORT);
  return [...new Set(args)];
}

const browser=await puppeteer.launch({
  headless:true,
  executablePath:await chromium.executablePath(),
  args:buildArgs()
});
const page=await browser.newPage();
const browserDiagnostics=[];
page.on("console",(msg)=>{
  browserDiagnostics.push({type:"console",level:msg.type(),text:msg.text().slice(0,500)});
});
page.on("pageerror",(err)=>{
  browserDiagnostics.push({type:"pageerror",text:String(err?.stack||err?.message||err).slice(0,1200)});
});
page.on("requestfailed",(req)=>{
  browserDiagnostics.push({type:"requestfailed",url:req.url(),failure:req.failure()?.errorText||null});
});
page.on("response",(resp)=>{
  const u=resp.url();
  if(u.includes("/wc/") || u.includes("webcontainer") || resp.status()>=400){
    browserDiagnostics.push({type:"response",url:u,status:resp.status(),ct:resp.headers()["content-type"]||null});
  }
});
const probes=[];
try{
  await page.goto("http://127.0.0.1:"+PORT+"/",{waitUntil:"domcontentloaded",timeout:15000});
  await page.evaluate(()=>{\n    void (async()=>{
    const status=document.getElementById("status");
    window.__bootDiag={
      stage:"IMPORT_START",
      classicRan:window.__classicRan===true,
      coi:globalThis.crossOriginIsolated===true,
      sab:typeof SharedArrayBuffer==="function",
      secure:globalThis.isSecureContext===true,
      hc:navigator.hardwareConcurrency||null,
      dm:navigator.deviceMemory||null,
      ua:navigator.userAgent
    };
    try{
      const mod=await import("/wc/index.js");
      window.__bootDiag.stage="IMPORTED";
      window.__bootDiag.imported=true;
      const wc=await mod.WebContainer.boot({coep:"credentialless"});
      window.__bootDiag.stage="BOOTED";
      window.__bootDiag.booted=true;
      await wc.fs.writeFile("/package.json",JSON.stringify({name:"zeibael-capacity",version:"1.0.0",private:true,type:"module"}));
      const task=[
        'import crypto from "node:crypto";',
        'const id=Number(process.argv[2]||0);',
        'const p=JSON.stringify({id,symbol:"ZEIBAEL",live_order_enabled:false});',
        'if(JSON.parse(p).live_order_enabled!==false) process.exit(2);',
        'const h=crypto.createHash("sha256").update(p).digest("hex");',
        'if(h.length!==64) process.exit(3);'
      ].join("\n");
      await wc.fs.writeFile("/task.mjs",task);
      async function drain(proc){
        const reader=proc.output.getReader();
        for(;;){const x=await reader.read();if(x.done)break;}
      }
      window.zeibaelRun=async({count,concurrency})=>{
        const started=performance.now();
        let next=0,completed=0,failed=0,active=0,maxActive=0;
        return await new Promise(resolve=>{
          const launch=()=>{
            while(active<concurrency&&next<count){
              const id=next++; active++; if(active>maxActive)maxActive=active;
              (async()=>{
                try{
                  const p=await wc.spawn("node",["task.mjs",String(id)]);
                  await drain(p);
                  const code=await p.exit;
                  if(code!==0)failed++;
                }catch{failed++;}
                completed++; active--;
                if(completed===count)resolve({ok:failed===0,completed,failed,max_active:maxActive,elapsed_ms:Math.round(performance.now()-started)});
                else launch();
              })();
            }
          };
          launch();
        });
      };
      window.__bootDiag.stage="READY";
      status.textContent="READY";
    }catch(e){
      window.__bootDiag.stage="ERROR";
      window.__bootDiag.error=String(e?.stack||e?.message||e).slice(0,2000);
      status.textContent="BOOT_ERROR:"+String(e?.message||e).slice(0,1000);
    }
    })();
  });
  const deadline=Date.now()+STARTUP_TIMEOUT_MS;
  let diag=null;
  while(Date.now()<deadline){
    diag=await page.evaluate(()=>({
      status:document.getElementById("status")?.textContent||null,
      coi:globalThis.crossOriginIsolated===true,
      sab:typeof SharedArrayBuffer==="function",
      secure:globalThis.isSecureContext===true,
      hasRun:typeof window.zeibaelRun==="function",
      bootDiag:window.__bootDiag||null
    }));
    if(diag.status==="READY"&&diag.coi&&diag.sab&&diag.secure&&diag.hasRun)break;
    if(String(diag.status||"").startsWith("BOOT_ERROR:"))break;
    await new Promise(r=>setTimeout(r,250));
  }
  console.log("ZEIBAEL_ACCELERATOR_STARTUP="+JSON.stringify({...diag,browser_diagnostics:browserDiagnostics.slice(-80)}));
  if(!(diag?.status==="READY"&&diag?.coi&&diag?.sab&&diag?.secure&&diag?.hasRun)){
    console.log("ZEIBAEL_ACCELERATOR_RESULT="+JSON.stringify({
      schema:"zeibael.blitz.accelerator-capacity.v3",
      status:"HOST_CAPABILITY_FAILURE",startup:diag,browser_diagnostics:browserDiagnostics.slice(-80),probes
    }));
    process.exitCode=2;
  }else{
    async function probe(c,label){
      const t0=Date.now();
      let result;
      try{
        result=await page.evaluate(async({c,timeout})=>{
          let timer;
          try{
            return await Promise.race([
              window.zeibaelRun({count:c,concurrency:c}),
              new Promise((_,rej)=>timer=setTimeout(()=>rej(new Error("STEP_TIMEOUT")),timeout))
            ]);
          }finally{clearTimeout(timer)}
        },{c,timeout:STEP_TIMEOUT_MS});
        result={candidate:c,ok:result?.ok===true,timeout:false,...result,label,host_elapsed_ms:Date.now()-t0};
      }catch(e){
        const msg=String(e?.message||e);
        result={candidate:c,ok:false,timeout:msg.includes("STEP_TIMEOUT"),host_error:msg,label,host_elapsed_ms:Date.now()-t0};
      }
      probes.push(result);
      console.log("ZEIBAEL_ACCELERATOR_PROBE="+JSON.stringify(result));
      return result;
    }

    let low=0,high=null;
    for(const c of CANDIDATES){
      const r=await probe(c,"ramp");
      if(r.ok)low=c;
      else{high=c;break;}
    }

    if(low===0){
      console.log("ZEIBAEL_ACCELERATOR_RESULT="+JSON.stringify({
        schema:"zeibael.blitz.accelerator-capacity.v3",
        status:"NO_STABLE_CAPACITY",max_stable_parallel_slots:null,first_timeout_or_fail:high,probes
      }));
      process.exitCode=2;
    }else if(high===null){
      console.log("ZEIBAEL_ACCELERATOR_RESULT="+JSON.stringify({
        schema:"zeibael.blitz.accelerator-capacity.v3",
        status:"LOWER_BOUND_ONLY",max_stable_parallel_slots:low,first_timeout_or_fail:null,
        safe_operating_slots:Math.max(1,Math.floor(low*0.9)),probes
      }));
    }else{
      while(high-low>1){
        const mid=Math.floor((low+high)/2);
        const r=await probe(mid,"binary");
        if(r.ok)low=mid;else high=mid;
      }
      const confirmGood=await probe(low,"confirm_pass");
      const confirmBad=await probe(high,"confirm_fail");
      const exact=confirmGood.ok&&!confirmBad.ok&&high===low+1;
      console.log("ZEIBAEL_ACCELERATOR_RESULT="+JSON.stringify({
        schema:"zeibael.blitz.accelerator-capacity.v3",
        status:exact?"EXACT_BOUNDARY_CONFIRMED":"VARIABLE_BOUNDARY",
        max_stable_parallel_slots:exact?low:null,
        first_timeout_or_fail:exact?high:null,
        safe_operating_slots:Math.max(1,Math.floor(low*0.9)),
        worker_thread_ceiling_reference:1791,
        probes
      }));
      if(!exact)process.exitCode=2;
    }
  }
}finally{
  await page.close().catch(()=>{});
  await browser.close().catch(()=>{});
  server.close();
}
