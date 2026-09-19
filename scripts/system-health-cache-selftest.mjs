import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSafeSystemHealthPayload, readSystemHealthCache, writeSystemHealthCache } from "../src/system-health-cache.mjs";

const dir = await mkdtemp(join(tmpdir(), "zeibael-health-cache-"));
const url = "https://example.test/health?mode=fast";
const safe = { ok:true, service:"ZEIBAEL_BLITZ_HEALTH", secrets_exposed:false, live_order_enabled:false, checks:[{name:"a",required:true,ok:true},{name:"b",required:false,ok:false}] };
const unsafe = { ...safe, live_order_enabled:true };
try {
  const writeOk = await writeSystemHealthCache(url,safe,{dir});
  const hit = await readSystemHealthCache(url,{dir,ttlMs:5000});
  const wrongUrl = await readSystemHealthCache(url+"&x=1",{dir,ttlMs:5000});
  await new Promise(r=>setTimeout(r,3));
  const expired = await readSystemHealthCache(url,{dir,ttlMs:1});
  const unsafeRejected = isSafeSystemHealthPayload(unsafe)===false && await writeSystemHealthCache(url,unsafe,{dir})===false;
  const ok = writeOk===true && hit?.payload?.ok===true && wrongUrl===null && expired===null && unsafeRejected;
  console.log("BLITZ_SYSTEM_HEALTH_CACHE_SELFTEST="+JSON.stringify({schema:"zeibael.system-health-cache-selftest.v1",ok,hit:Boolean(hit),wrong_url_rejected:wrongUrl===null,expiration_verified:expired===null,unsafe_rejected:unsafeRejected,live_order_enabled:false}));
  if(!ok) process.exitCode=1;
} finally { await rm(dir,{recursive:true,force:true}); }
