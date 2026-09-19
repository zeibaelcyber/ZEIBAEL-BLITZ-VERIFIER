const port=Number(process.env.PORT||19091);
const token=process.env.ZEIBAEL_BURST_TOKEN||"";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function getJson(path,opts={}){
  const r=await fetch("http://127.0.0.1:"+port+path,opts);
  const body=await r.json();
  return {status:r.status,body};
}
async function waitHealth(){
  let last=null;
  for(let i=0;i<120;i++){
    try{
      const x=await getJson("/health");
      last=x;
      if(x.status===200&&x.body?.ready===true)return x.body;
    }catch(e){last={error:String(e?.message||e)}}
    await sleep(100);
  }
  throw new Error("health_timeout:"+JSON.stringify(last));
}
async function burst(tasks,concurrency=2,workloadProfile="LIGHT"){
  return await getJson("/burst",{
    method:"POST",
    headers:{authorization:"Bearer "+token,"content-type":"application/json"},
    body:JSON.stringify({
      route:{execution_class:"LOCAL_BLITZ",broker_required:false},
      tasks,
      concurrency,
      workload_profile:workloadProfile,
      live_order_enabled:false
    })
  });
}
try{
  if(!token)throw new Error("token_required");
  const h1=await waitHealth();
  const tasks=[
    {id:"a",code:"console.log(20+22)",kernel_safe:true,cache_safe:true},
    {id:"b",code:"import crypto from \"node:crypto\";console.log(crypto.createHash(\"sha256\").update(\"x\").digest(\"hex\").slice(0,6))",kernel_safe:true,cache_safe:true}
  ];
  const first=await burst(tasks);
  const second=await burst(tasks.map((t,i)=>({...t,id:i===0?"a2":"b2"})));
  const coalesceProbe=await burst([
    {id:"c1",code:"console.log('coalesce-proof-20260919')",kernel_safe:true,cache_safe:true,timeout_ms:1000},
    {id:"c2",code:"console.log('coalesce-proof-20260919')",kernel_safe:true,cache_safe:true,timeout_ms:1000},
    {id:"c3",code:"console.log('coalesce-proof-20260919')",kernel_safe:true,cache_safe:true,timeout_ms:1000},
    {id:"c4",code:"console.log('coalesce-proof-20260919')",kernel_safe:true,cache_safe:true,timeout_ms:1000}
  ],4,"LIGHT");
  const slotProbe=await burst([
    {id:"slot-dup-1",code:"await new Promise(r=>setTimeout(r,450));console.log('dup:'+Date.now())",kernel_safe:true,cache_safe:true,timeout_ms:1500},
    {id:"slot-dup-2",code:"await new Promise(r=>setTimeout(r,450));console.log('dup:'+Date.now())",kernel_safe:true,cache_safe:true,timeout_ms:1500},
    {id:"slot-u1",code:"console.log('u1:'+Date.now())",kernel_safe:true,cache_safe:false,timeout_ms:1500},
    {id:"slot-u2",code:"console.log('u2:'+Date.now())",kernel_safe:true,cache_safe:false,timeout_ms:1500}
  ],2,"LIGHT");
  const slotDupTs=Number(String(slotProbe.body?.results?.find(x=>x.id==="slot-dup-1")?.output||"").match(/dup:(\d+)/)?.[1]||0);
  const slotUniqueTs=slotProbe.body?.results
    ?.filter(x=>x.id==="slot-u1"||x.id==="slot-u2")
    ?.map(x=>Number(String(x.output||"").match(/u[12]:(\d+)/)?.[1]||0))
    ?.filter(Boolean) || [];
  const slotUniqueBeforeLeader=slotDupTs>0 && slotUniqueTs.length===2 && Math.min(...slotUniqueTs)<slotDupTs;
  const slotUniqueRows=slotProbe.body?.results?.filter(x=>x.id==="slot-u1"||x.id==="slot-u2")||[];
  const slotUniqueElapsed=slotUniqueRows.map(x=>Number(x?.elapsed_ms)).filter(Number.isFinite);
  const slotUniqueTailLimitMs=350;
  const slotUniqueTailOk=slotUniqueElapsed.length===2 && Math.max(...slotUniqueElapsed)<=slotUniqueTailLimitMs;
  const governorNegative=await burst([
    {id:"g-ok-1",code:"console.log(1)",kernel_safe:true,cache_safe:false,timeout_ms:1000},
    {id:"g-ok-2",code:"console.log(2)",kernel_safe:true,cache_safe:false,timeout_ms:1000},
    {id:"g-ok-3",code:"console.log(3)",kernel_safe:true,cache_safe:false,timeout_ms:1000},
    {id:"g-timeout",code:"await new Promise(()=>{})",kernel_safe:true,cache_safe:false,timeout_ms:500}
  ],4,"LIGHT");
  const broker=await getJson("/burst",{
    method:"POST",
    headers:{authorization:"Bearer "+token,"content-type":"application/json"},
    body:JSON.stringify({
      route:{execution_class:"CONNECTOR_BROKERED",broker_required:true},
      tasks:[{id:"x",code:"console.log(1)",kernel_safe:true,cache_safe:false}],
      concurrency:1,
      live_order_enabled:false
    })
  });
  const h2=(await getJson("/health")).body;
  const ok=
    h1.ready===true &&
    first.status===200 && first.body?.ok===true && Number(first.body?.executed)===2 &&
    second.status===200 && second.body?.ok===true && Number(second.body?.executed)===0 && Number(second.body?.cache?.hits)===2 &&
    coalesceProbe.status===200 && coalesceProbe.body?.ok===true &&
    Number(coalesceProbe.body?.executed)===1 &&
    Number(coalesceProbe.body?.attempts)===1 &&
    Number(coalesceProbe.body?.cache?.coalesced)===3 &&
    first.body?.results?.every(x=>x.worker_mode==="PREWARMED_ONE_SHOT_WORKER") &&
    first.body?.results?.every(x=>Number(x.elapsed_ms)<=100) &&
    h1.prewarmed_one_shot_workers===true &&
    Number(h1.prewarm_pool?.target)>=1 &&
    slotProbe.status===200 && slotProbe.body?.ok===true &&
    Number(slotProbe.body?.executed)===3 &&
    Number(slotProbe.body?.cache?.coalesced)===1 &&
    slotUniqueBeforeLeader===true &&
    slotUniqueTailOk===true &&
    h2.slot_preserving_coalescing===true &&
    Number(h2.prewarm_pool?.cold_fallbacks)===0 &&
    governorNegative.status===422 && governorNegative.body?.ok===false &&
    governorNegative.body?.adaptive_governor?.enabled===true &&
    governorNegative.body?.adaptive_governor?.downshifted===true &&
    Number(governorNegative.body?.adaptive_governor?.initial_concurrency)===4 &&
    Number(governorNegative.body?.adaptive_governor?.retry_concurrency)===2 &&
    Number(governorNegative.body?.adaptive_governor?.retried_tasks)===1 &&
    Number(governorNegative.body?.adaptive_governor?.recovered_tasks)===0 &&
    Number(governorNegative.body?.executed)===4 &&
    Number(governorNegative.body?.attempts)===5 &&
    h1.kernel_pid!=null && h1.kernel_pid===h2.kernel_pid &&
    broker.status===200 && broker.body?.status==="BROKER_REQUIRED" && broker.body?.executed===false &&
    h2.ready===true && h2.runner==="ZEIBAEL_BLITZ_WARM_RUNNER_V2" && Number(h2.restarts)===0 &&
    h2.canonical_state==="SUPABASE" && h2.live_order_enabled===false;
  const evidence={
    schema:"zeibael.blitz.warm-runner-selftest.v2",
    ok,
    kernel_pid:h1.kernel_pid,
    pid_reused:h1.kernel_pid===h2.kernel_pid,
    first:first.body,
    second:second.body,
    in_flight_coalescing:coalesceProbe.body,
    prewarmed_one_shot_workers:{
      ok:first.body?.results?.every(x=>x.worker_mode==="PREWARMED_ONE_SHOT_WORKER")===true,
      first_task_elapsed_ms:first.body?.results?.map(x=>x.elapsed_ms)||[],
      max_first_task_ms:100,
      no_cold_fallbacks:Number(h2.prewarm_pool?.cold_fallbacks)===0,
      pool:h2.prewarm_pool||h1.prewarm_pool||null
    },
    slot_preserving_coalescing:{
      ok:slotUniqueBeforeLeader&&slotUniqueTailOk,
      ordering_ok:slotUniqueBeforeLeader,
      tail_ok:slotUniqueTailOk,
      tail_limit_ms:slotUniqueTailLimitMs,
      unique_elapsed_ms:slotUniqueElapsed,
      max_unique_elapsed_ms:slotUniqueElapsed.length?Math.max(...slotUniqueElapsed):null,
      duplicate_leader_timestamp_ms:slotDupTs,
      unique_timestamps_ms:slotUniqueTs,
      probe:slotProbe.body
    },
    adaptive_governor_negative_control:governorNegative.body,
    broker:broker.body,
    health:h2,
    canonical_state:"SUPABASE",
    live_order_enabled:false
  };
  process.stdout.write("BLITZ_WARM_RUNNER_SELFTEST="+JSON.stringify(evidence)+"\n");
  process.exit(ok?0:1);
}catch(e){
  process.stdout.write("BLITZ_WARM_RUNNER_SELFTEST="+JSON.stringify({
    schema:"zeibael.blitz.warm-runner-selftest.v2",
    ok:false,
    error:String(e?.stack||e),
    canonical_state:"SUPABASE",
    live_order_enabled:false
  })+"\n");
  process.exit(1);
}
