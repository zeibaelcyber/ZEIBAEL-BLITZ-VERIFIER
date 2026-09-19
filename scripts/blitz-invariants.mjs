import { readFile } from 'node:fs/promises';

const inv = JSON.parse(await readFile('config/runtime-invariants.json','utf8'));
const expectedGlobal = inv.global_runtime.max_concurrency;
const expectedTasks = inv.global_runtime.max_tasks;
const profiles = inv.workload_profile_caps;

const files = {
  acker: await readFile('src/acker-accelerator.mjs','utf8'),
  warm: await readFile('services/warm-runner/server.mjs','utf8'),
  bridge: await readFile('services/bridge-driver/server.mjs','utf8'),
  fixture: await readFile('fixtures/browser-fabric-v19.html','utf8')
};

function fail(message){ throw new Error('BLITZ_INVARIANT_FAILED:'+message); }
function expect(re, text, label){ if(!re.test(text)) fail(label); }

expect(new RegExp('DEFAULT_WEBCONTAINER_SAFE_PARALLEL_SLOTS\\s*=\\s*'+expectedGlobal+'\\b'), files.acker, 'acker_global_concurrency');
expect(new RegExp('DEFAULT_MAX_CONCURRENCY\\s*=\\s*'+expectedGlobal+'\\b'), files.warm, 'warm_global_concurrency');
expect(new RegExp('DEFAULT_MAX_CONCURRENCY\\s*=\\s*'+expectedGlobal+'\\b'), files.bridge, 'bridge_global_concurrency');
expect(new RegExp('MAX_CONCURRENCY='+expectedGlobal+'\\b'), files.fixture, 'fixture_global_concurrency');

for (const [profile, cap] of Object.entries(profiles)) {
  const re = new RegExp(profile+'\\s*:\\s*'+cap+'\\b');
  for (const [name, text] of Object.entries(files)) expect(re, text, name+'_'+profile+'_cap');
}

expect(new RegExp('DEFAULT_MAX_TASKS='+expectedTasks+'\\b'), files.warm, 'warm_max_tasks');
expect(new RegExp('HARD_TASK_CEILING\\s*=\\s*'+expectedTasks+'\\b'), files.bridge, 'bridge_max_tasks');
expect(new RegExp('MAX_TASKS='+expectedTasks+'\\b'), files.fixture, 'fixture_max_tasks');

const stalePatterns = [
  /DEFAULT_WEBCONTAINER_SAFE_PARALLEL_SLOTS\s*=\s*57\b/,
  /DEFAULT_MAX_CONCURRENCY\s*=\s*57\b/,
  /MAX_CONCURRENCY=57\b/,
  /requested_max\s*:\s*57\b/,
  /BLITZ_MAX_57_PASS/
];
for (const [name,text] of Object.entries(files)) {
  for (const pattern of stalePatterns) if(pattern.test(text)) fail(name+'_stale_57_limiter');
}

async function fetchJson(url, attempts=4) {
  let last;
  for(let i=0;i<attempts;i++){
    try{
      const r=await fetch(url,{headers:{accept:'application/json'}});
      const body=await r.json();
      if(r.ok) return {status:r.status,body};
      last=new Error('HTTP_'+r.status+':'+JSON.stringify(body).slice(0,500));
    }catch(e){last=e}
    await new Promise(r=>setTimeout(r,300*(i+1)));
  }
  throw last;
}

async function fetchText(url, attempts=4) {
  let last;
  for(let i=0;i<attempts;i++){
    try{
      const r=await fetch(url,{headers:{accept:'text/html,*/*'}});
      const body=await r.text();
      if(r.ok) return {status:r.status,body};
      last=new Error('HTTP_'+r.status+':'+body.slice(0,500));
    }catch(e){last=e}
    await new Promise(r=>setTimeout(r,300*(i+1)));
  }
  throw last;
}

const healthUrl='https://pfxcdxxxcyoinlksruoy.supabase.co/functions/v1/zeibael-blitz-health?mode=fast';
const health=(await fetchJson(healthUrl)).body;
if(health.ok!==true) fail('health_not_ok');
if(health.live_order_enabled!==false) fail('health_live_order_enabled');
if(health.secrets_exposed!==false) fail('health_secrets_exposed');
const checks=health.checks||[];
const registry=checks.find(x=>x?.name==='blitz.primary_registry');
if(registry?.ok!==true) fail('primary_registry_not_ok');
if(Number(registry?.detail?.max_concurrency)!==expectedGlobal) fail('health_global_concurrency');
if(inv.required?.warm_runner_runtime_verified===true && registry?.detail?.runtime_verified!==true) fail('warm_runner_runtime_not_verified');
const zeroSpend=checks.find(x=>x?.name==='supabase.zero_spend_guard');
if(inv.required?.zero_spend===true && zeroSpend?.ok!==true) fail('zero_spend_guard_not_ok');
const warmOidc=checks.find(x=>x?.name==='blitz.warm_runner_persisted_oidc_sentinel');
if(inv.required?.oidc_sentinel_required===true && warmOidc?.ok!==true) fail('warm_runner_oidc_sentinel_not_ok');
const browser=checks.find(x=>x?.name==='blitz.browser_fabric_runtime');
if(browser?.ok!==true || browser?.required!==true) fail('browser_fabric_required_runtime_not_ok');

const directUrl='https://pfxcdxxxcyoinlksruoy.supabase.co/functions/v1/zeibael-stackblitz-direct?lane=stackblitz-compute-v1';
const direct=(await fetchText(directUrl)).body;
if(!direct.includes('MAX_CONCURRENCY='+expectedGlobal)) fail('live_edge_global_concurrency');
if(!direct.includes('MAX_TASKS='+expectedTasks)) fail('live_edge_max_tasks');
for(const [profile,cap] of Object.entries(profiles)){
  const compact=profile+':'+cap;
  const spaced=profile+': '+cap;
  if(!direct.includes(compact)&&!direct.includes(spaced)) fail('live_edge_'+profile+'_cap');
}
if(/MAX_CONCURRENCY=57\b/.test(direct)||/BLITZ_MAX_57_PASS/.test(direct)) fail('live_edge_stale_57');

const evidence={
  schema:'zeibael.blitz.runtime-invariants.evidence.v1',
  ok:true,
  global_runtime:inv.global_runtime,
  workload_profile_caps:profiles,
  health:{
    ok:health.ok,
    version:health.version,
    required_pass:health.summary?.pass??null,
    required_total:health.summary?.total_required??null,
    primary_registry_ok:registry?.ok===true,
    zero_spend_ok:zeroSpend?.ok===true,
    warm_oidc_ok:warmOidc?.ok===true,
    browser_fabric_required_ok:browser?.ok===true
  },
  live_edge:{
    max_concurrency:expectedGlobal,
    max_tasks:expectedTasks,
    stale_57:false
  },
  live_order_enabled:false
};
process.stdout.write('ZEIBAEL_BLITZ_INVARIANTS='+JSON.stringify(evidence)+'\n');
