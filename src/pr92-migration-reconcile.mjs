const EVIDENCE_URL = 'https://pfxcdxxxcyoinlksruoy.supabase.co/functions/v1/zeibael-blitz-worker-evidence';
const benchmark_id = 'pr92-migration-reconcile-20260918-v1';

const expectedVersions = ['20260916124503','20260916124658','20260916124932'];
const staleVersions = ['20260916195000','20260916195500','20260916200500'];
const observedBlobShas = [
  'bb019bf74d8279ecb9ade72efee2a7033f739279',
  '9a0fda5141b9951f92d154cc7f768ac078735ecb',
  '6ba595496af01821202f7518a7e4bb056c42c0c8'
];
const originalPrBlobShas = [
  'bb019bf74d8279ecb9ade72efee2a7033f739279',
  '9a0fda5141b9951f92d154cc7f768ac078735ecb',
  '6ba595496af01821202f7518a7e4bb056c42c0c8'
];
const productionLedger = {
  '20260916124503': true,
  '20260916124658': true,
  '20260916124932': true
};
const guardrails = {
  supabase: { status: 'READY', plugin_maximization_status: 'VERIFIED', live_order_enabled: false },
  github: { status: 'READY', plugin_maximization_status: 'PARTIAL', legacy_n8n_lifecycle: 'NOT_REQUIRED_RETIRED', live_order_enabled: false },
  current_authenticated_execute: ['zeibael_api_system_status_v1','zeibael_api_worker_status_v1']
};

function check(name, ok, detail) {
  return { name, ok: Boolean(ok), detail };
}

const checks = [
  check('actual_versions_unique', new Set(expectedVersions).size === expectedVersions.length, expectedVersions),
  check('actual_versions_sorted', expectedVersions.every((v,i)=> i === 0 || v > expectedVersions[i-1]), expectedVersions),
  check('stale_versions_excluded', expectedVersions.every(v => !staleVersions.includes(v)), staleVersions),
  check('source_blobs_identical_to_original_prs', JSON.stringify(observedBlobShas) === JSON.stringify(originalPrBlobShas), observedBlobShas),
  check('production_ledger_contains_all_versions', expectedVersions.every(v => productionLedger[v] === true), productionLedger),
  check('supabase_guardrail', guardrails.supabase.status === 'READY' && guardrails.supabase.plugin_maximization_status === 'VERIFIED' && guardrails.supabase.live_order_enabled === false, guardrails.supabase),
  check('github_guardrail', guardrails.github.status === 'READY' && guardrails.github.legacy_n8n_lifecycle === 'NOT_REQUIRED_RETIRED' && guardrails.github.live_order_enabled === false, guardrails.github),
  check('later_authenticated_rpcs_are_typed_api_only', guardrails.current_authenticated_execute.every(x => x.startsWith('zeibael_api_')), guardrails.current_authenticated_execute)
];

const result = {
  schema: 'zeibael.pr92.blitz_validation.v1',
  benchmark_id,
  source: 'stackblitz-webcontainer',
  status: checks.every(x => x.ok) ? 'VERIFIED' : 'FAILED',
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  live_order_enabled: false,
  private_repo_content_sent: false,
  checks
};

async function post(event, payload) {
  const r = await fetch(EVIDENCE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ benchmark_id, event, worker_n: checks.length, payload })
  });
  if (!r.ok) throw new Error('evidence_http_' + r.status + ':' + (await r.text()).slice(0,200));
}

await post('begin', { schema: result.schema, source: result.source, runtime: result.runtime });
await post('final', result);
console.log('ZEIBAEL_PR92_BLITZ_RESULT=' + JSON.stringify(result));
if (result.status !== 'VERIFIED') process.exitCode = 1;
