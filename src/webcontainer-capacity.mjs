import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import os from 'node:os';

const EVIDENCE_URL='https://pfxcdxxxcyoinlksruoy.supabase.co/functions/v1/zeibael-blitz-worker-evidence';

async function postEvidence(benchmark_id,event,worker_n,payload){
  try{
    const r=await fetch(EVIDENCE_URL,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({benchmark_id,event,worker_n,payload})
    });
    if(!r.ok) console.log('EVIDENCE_POST_FAILED '+JSON.stringify({benchmark_id,event,worker_n,status:r.status,body:(await r.text()).slice(0,160)}));
    return r.ok;
  }catch(e){
    console.log('EVIDENCE_POST_FAILED '+JSON.stringify({benchmark_id,event,worker_n,error:e?.message||String(e)}));
    return false;
  }
}

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

if(!isMainThread){
  if(workerData?.mode==='worker-only'){
    parentPort.postMessage({type:'ready'});
    setInterval(()=>{},1000);
  }else{
    parentPort.postMessage({type:'bad_mode'});
  }
}else{
  const runtime={node:process.version,platform:process.platform,arch:process.arch,cpus:os.cpus().length,totalmem:os.totalmem(),freemem_start:os.freemem()};
  const stamp=Date.now()+'-'+Math.random().toString(36).slice(2,8);

  // PHASE 1: worker/thread boundary with no intentional per-worker payload allocation.
  const WORKER_MAX=Number(process.env.WORKER_MAX||128);
  const READY_TIMEOUT_MS=Number(process.env.READY_TIMEOUT_MS||8000);
  const worker_id='webcontainer-capacity-worker-'+stamp;
  const workers=[];
  let workerStable=0,workerFailure=null;
  console.log('ZEIBAEL_WORKER_ONLY_BEGIN='+JSON.stringify({benchmark_id:worker_id,runtime,max_workers:WORKER_MAX}));
  await postEvidence(worker_id,'begin',0,{schema:'zeibael.webcontainer.worker_only.v1',runtime,max_workers:WORKER_MAX});

  for(let n=1;n<=WORKER_MAX;n++){
    try{
      const w=new Worker(new URL(import.meta.url),{workerData:{mode:'worker-only'}});
      workers.push(w);
      await new Promise((resolve,reject)=>{
        const t=setTimeout(()=>reject(new Error('ready_timeout')),READY_TIMEOUT_MS);
        w.once('message',m=>{clearTimeout(t);m?.type==='ready'?resolve():reject(new Error('bad_ready'));});
        w.once('error',e=>{clearTimeout(t);reject(e);});
      });
      workerStable=n;
      if(n<=20||n%5===0){
        await postEvidence(worker_id,'stable_checkpoint',n,{workers:n,rss:process.memoryUsage().rss});
      }
    }catch(e){
      workerFailure={worker:n,reason:e?.message||String(e)};
      await postEvidence(worker_id,'failure',n,{...workerFailure,rss:process.memoryUsage().rss});
      break;
    }
  }

  const workerResult={
    schema:'zeibael.webcontainer.worker_only.v1',
    benchmark_id:worker_id,
    status:workerFailure?'BOUNDARY_OBSERVED':'LOWER_BOUND_ONLY',
    max_stable_workers:workerStable,
    first_failed_worker:workerFailure?.worker??null,
    failure:workerFailure?.reason??null,
    runtime,
    final:{rss:process.memoryUsage().rss}
  };
  console.log('ZEIBAEL_WORKER_ONLY_RESULT='+JSON.stringify(workerResult));
  await postEvidence(worker_id,'final',workerFailure?.worker??workerStable,workerResult);
  await Promise.allSettled(workers.map(w=>w.terminate()));
  await sleep(1500);

  // PHASE 2: RAM boundary in one process, so worker/thread limits cannot contaminate the result.
  const MiB=1024*1024;
  const CHUNK_MIB=Number(process.env.RAM_CHUNK_MIB||16);
  const RAM_MAX_MIB=Number(process.env.RAM_MAX_MIB||1024);
  const ram_id='webcontainer-capacity-ram-'+stamp;
  const blocks=[];
  let allocated=0,ramFailure=null;
  console.log('ZEIBAEL_RAM_ONLY_BEGIN='+JSON.stringify({benchmark_id:ram_id,runtime,chunk_mib:CHUNK_MIB,max_mib:RAM_MAX_MIB}));
  await postEvidence(ram_id,'begin',0,{schema:'zeibael.webcontainer.ram_only.v1',runtime,chunk_mib:CHUNK_MIB,max_mib:RAM_MAX_MIB});

  for(let chunk=1;allocated+CHUNK_MIB<=RAM_MAX_MIB;chunk++){
    try{
      const b=Buffer.alloc(CHUNK_MIB*MiB,0x5a);
      // Touch multiple pages so this is committed payload, not a merely reserved range.
      for(let i=0;i<b.length;i+=4096) b[i]^=1;
      blocks.push(b);
      allocated+=CHUNK_MIB;
      await postEvidence(ram_id,'stable_checkpoint',chunk,{allocated_mib:allocated,chunk_mib:CHUNK_MIB,rss:process.memoryUsage().rss});
      await sleep(120);
    }catch(e){
      ramFailure={chunk,reason:e?.message||String(e),allocated_mib:allocated};
      await postEvidence(ram_id,'failure',chunk,{...ramFailure,rss:process.memoryUsage().rss});
      break;
    }
  }

  const ramResult={
    schema:'zeibael.webcontainer.ram_only.v1',
    benchmark_id:ram_id,
    status:ramFailure?'BOUNDARY_OBSERVED':'LOWER_BOUND_ONLY',
    max_stable_allocated_mib:allocated,
    first_failed_chunk:ramFailure?.chunk??null,
    failure:ramFailure?.reason??null,
    chunk_mib:CHUNK_MIB,
    max_tested_mib:RAM_MAX_MIB,
    runtime,
    final:{rss:process.memoryUsage().rss}
  };
  console.log('ZEIBAEL_RAM_ONLY_RESULT='+JSON.stringify(ramResult));
  await postEvidence(ram_id,'final',Math.floor(allocated/CHUNK_MIB),ramResult);

  // Keep the allocations alive briefly after final evidence to prove simultaneous residency.
  await sleep(3000);
}
