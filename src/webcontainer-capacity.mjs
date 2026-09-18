import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import os from 'node:os';

const EVIDENCE_URL='https://pfxcdxxxcyoinlksruoy.supabase.co/functions/v1/zeibael-blitz-worker-evidence';
async function postEvidence(benchmark_id,event,worker_n,payload){
  try {
    const r=await fetch(EVIDENCE_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({benchmark_id,event,worker_n,payload})});
    if(!r.ok) console.log('EVIDENCE_POST_FAILED '+JSON.stringify({event,worker_n,status:r.status,body:(await r.text()).slice(0,160)}));
    return r.ok;
  } catch(e) { console.log('EVIDENCE_POST_FAILED '+JSON.stringify({event,worker_n,error:e?.message||String(e)})); return false; }
}

if (!isMainThread) {
  const bytes = workerData.bytes;
  const block = Buffer.alloc(bytes, 0x5a);
  parentPort.postMessage({ type: 'ready', bytes, checksum: block[0] + block[bytes - 1] });
  setInterval(() => { block[0] ^= 1; block[0] ^= 1; }, 1000);
} else {
  const MiB = 1024 * 1024;
  const PER_WORKER_MIB = Number(process.env.PER_WORKER_MIB || 8);
  const MAX_WORKERS = Number(process.env.MAX_WORKERS || 512);
  const READY_TIMEOUT_MS = Number(process.env.READY_TIMEOUT_MS || 8000);
  const benchmark_id='webcontainer-capacity-'+Date.now()+'-'+Math.random().toString(36).slice(2,8);
  const workers = [];
  const runtime = { node:process.version, platform:process.platform, arch:process.arch, cpus:os.cpus().length, totalmem:os.totalmem(), freemem_start:os.freemem() };
  console.log('ZEIBAEL_WEB_CONTAINER_CAPACITY_BEGIN='+JSON.stringify({benchmark_id,runtime,per_worker_mib:PER_WORKER_MIB,max_workers:MAX_WORKERS}));
  await postEvidence(benchmark_id,'begin',0,{schema:'zeibael.webcontainer.capacity.v1',runtime,per_worker_mib:PER_WORKER_MIB,max_workers:MAX_WORKERS});
  let stable=0, failure=null;
  for(let n=1;n<=MAX_WORKERS;n++){
    try{
      const w=new Worker(new URL(import.meta.url),{workerData:{bytes:PER_WORKER_MIB*MiB}}); workers.push(w);
      await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('ready_timeout')),READY_TIMEOUT_MS);w.once('message',m=>{clearTimeout(t);m?.type==='ready'?resolve():reject(new Error('bad_ready'));});w.once('error',e=>{clearTimeout(t);reject(e);});});
      stable=n;
      if(n<=10||n%10===0){const p={workers:n,allocated_mib:n*PER_WORKER_MIB,rss:process.memoryUsage().rss,freemem:os.freemem()};console.log('CAPACITY_STABLE '+JSON.stringify(p));await postEvidence(benchmark_id,'stable_checkpoint',n,p);}
    }catch(e){failure={worker:n,reason:e?.message||String(e)};console.log('CAPACITY_FIRST_FAILURE '+JSON.stringify(failure));await postEvidence(benchmark_id,'failure',n,{...failure,rss:process.memoryUsage().rss,freemem:os.freemem()});break;}
  }
  const result={schema:'zeibael.webcontainer.capacity.v1',benchmark_id,status:failure?'BOUNDARY_OBSERVED':'LOWER_BOUND_ONLY',max_stable_workers:stable,first_failed_worker:failure?.worker??null,failure:failure?.reason??null,per_worker_mib:PER_WORKER_MIB,allocated_mib:stable*PER_WORKER_MIB,runtime,final:{rss:process.memoryUsage().rss,freemem:os.freemem()}};
  console.log('ZEIBAEL_WEB_CONTAINER_CAPACITY_RESULT='+JSON.stringify(result));
  await postEvidence(benchmark_id,'final',failure?.worker??stable,result);
  await Promise.allSettled(workers.map(w=>w.terminate()));
}