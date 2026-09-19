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
async function burst(tasks){
  return await getJson("/burst",{
    method:"POST",
    headers:{authorization:"Bearer "+token,"content-type":"application/json"},
    body:JSON.stringify({
      route:{execution_class:"LOCAL_BLITZ",broker_required:false},
      tasks,
      concurrency:2,
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
