import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { compileSmartPacket } from './smart-packet.mjs';
import { openBlitzResultCache } from './blitz-cache.mjs';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node src/acker-accelerator.mjs <packet.json>');
  process.exit(2);
}

const rawPacket = JSON.parse(await readFile(inputPath, 'utf8'));
const compiled = compileSmartPacket(rawPacket);
const packet = compiled.packet;
const jobs = Array.isArray(packet.jobs) ? packet.jobs : [];
const byId = new Map(jobs.map(j => [j.id, j]));
const executionRank = new Map(compiled.executionOrder.map((id, index) => [id, index]));
const state = new Map();
const startedAt = Date.now();
const WORKER_THREAD_CEILING_REFERENCE = 1791;
const DEFAULT_WEBCONTAINER_SAFE_PARALLEL_SLOTS = 64;
const configuredConcurrencyCap = Number(process.env.ZEIBAEL_MAX_CONCURRENCY || DEFAULT_WEBCONTAINER_SAFE_PARALLEL_SLOTS);
const WEBCONTAINER_SAFE_PARALLEL_SLOTS =
  Number.isFinite(configuredConcurrencyCap) && configuredConcurrencyCap >= 1
    ? Math.min(WORKER_THREAD_CEILING_REFERENCE, Math.floor(configuredConcurrencyCap))
    : DEFAULT_WEBCONTAINER_SAFE_PARALLEL_SLOTS;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const WORKLOAD_CAPS = Object.freeze({
  LIGHT: 17,
  IO: 23,
  BUILD_TEST: 24,
  CPU_HEAVY: 32
});
function workloadProfile(job) {
  const explicit = String(job?.workload_profile || packet?.workload_profile || '').toUpperCase();
  if (Object.prototype.hasOwnProperty.call(WORKLOAD_CAPS, explicit)) return explicit;
  if (job?.type === 'http') return 'IO';
  if (job?.type === 'command') return 'BUILD_TEST';
  return 'LIGHT';
}
function workloadCap(profile) {
  return Math.min(WEBCONTAINER_SAFE_PARALLEL_SLOTS, WORKLOAD_CAPS[profile] || WEBCONTAINER_SAFE_PARALLEL_SLOTS);
}
const requestedConcurrency = Number(packet.max_concurrency ?? packet.concurrency ?? jobs.length);
const maxConcurrency =
  Number.isFinite(requestedConcurrency) && requestedConcurrency >= 1
    ? Math.min(WEBCONTAINER_SAFE_PARALLEL_SLOTS, Math.floor(requestedConcurrency))
    : Math.min(WEBCONTAINER_SAFE_PARALLEL_SLOTS, Math.max(1, jobs.length));
const cache = await openBlitzResultCache();
let cacheHits = 0;
let cacheMisses = 0;
let cacheWrites = 0;

function safeText(v, max = 12000) {
  const s = String(v ?? '');
  return s.length > max ? s.slice(-max) : s;
}

function cacheConfig(job) {
  if (job.cache_safe !== true || typeof job.zeibael_fingerprint !== 'string') return null;
  const ttl = Number(job.cache_ttl_ms ?? packet.cache_ttl_ms ?? DEFAULT_CACHE_TTL_MS);
  if (!Number.isFinite(ttl) || ttl < 1) return null;
  return { key: `job-v1:${job.zeibael_fingerprint}`, ttl };
}

async function runCommand(job) {
  const started = Date.now();
  return await new Promise(resolve => {
    const child = spawn(job.shell || 'sh', ['-lc', job.command], {
      env: { ...process.env, ...(job.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, Number(job.timeout_ms || 30000));
    child.stdout.on('data', d => { stdout = safeText(stdout + d); });
    child.stderr.on('data', d => { stderr = safeText(stderr + d); });
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ id: job.id, type: job.type, status: 'FAILED', duration_ms: Date.now()-started, error: String(err.message || err) });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({
        id: job.id,
        type: job.type,
        status: code === 0 ? 'PASS' : 'FAILED',
        exit_code: code,
        duration_ms: Date.now()-started,
        stdout,
        stderr
      });
    });
  });
}

async function runHttp(job) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(job.timeout_ms || 10000));
  try {
    const r = await fetch(job.url, {
      method: job.method || 'GET',
      headers: job.headers || {},
      body: job.body ?? undefined,
      signal: controller.signal,
      redirect: 'follow'
    });
    const text = safeText(await r.text(), 12000);
    const expected = Array.isArray(job.accept_status) ? job.accept_status : null;
    const pass = expected ? expected.includes(r.status) : r.ok;
    return {
      id: job.id,
      type: job.type,
      status: pass ? 'PASS' : 'FAILED',
      http_status: r.status,
      duration_ms: Date.now()-started,
      body: text
    };
  } catch (e) {
    return {
      id: job.id,
      type: job.type,
      status: 'FAILED',
      duration_ms: Date.now()-started,
      error: String(e?.message || e)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runInline(job) {
  const started = Date.now();
  try {
    const value = await Function('"use strict"; return (async()=>{'+job.code+'})()')();
    return { id: job.id, type: job.type, status: 'PASS', duration_ms: Date.now()-started, value };
  } catch (e) {
    return { id: job.id, type: job.type, status: 'FAILED', duration_ms: Date.now()-started, error: String(e?.stack || e) };
  }
}

async function executeUncached(job) {
  if (job.type === 'command') return runCommand(job);
  if (job.type === 'http') return runHttp(job);
  if (job.type === 'inline') return runInline(job);
  return { id: job.id, type: job.type, status: 'FAILED', duration_ms: 0, error: 'unsupported_job_type' };
}

async function execute(job) {
  const cfg = cacheConfig(job);
  if (cfg) {
    const hit = cache.get(cfg.key);
    if (hit?.result?.status === 'PASS') {
      cacheHits++;
      return {
        ...hit.result,
        id: job.id,
        type: job.type,
        duration_ms: 0,
        cache_hit: true,
        cache_stored_at: hit.stored_at,
        cache_expires_at: hit.expires_at
      };
    }
    cacheMisses++;
  }

  const result = await executeUncached(job);
  if (cfg && result.status === 'PASS') {
    cache.set(cfg.key, { ...result, cache_hit: false }, cfg.ttl);
    cacheWrites++;
  }
  return { ...result, cache_hit: false };
}

function deps(job) {
  return Array.isArray(job.depends_on) ? job.depends_on : [];
}

function depsSatisfied(job) {
  return deps(job).every(id => state.get(id)?.status === 'PASS');
}

function depsTerminal(job) {
  return deps(job).every(id => {
    const s = state.get(id)?.status;
    return s === 'PASS' || s === 'FAILED' || s === 'BLOCKED';
  });
}

const pending = new Set(jobs.map(j => j.id));
const running = new Map();
const runningByProfile = new Map(Object.keys(WORKLOAD_CAPS).map(k => [k, 0]));
const readyOrder = jobs.map(j => j.id).sort((a, b) => (executionRank.get(a) ?? 999999) - (executionRank.get(b) ?? 999999));

while (pending.size || running.size) {
  let launched = 0;

  for (const id of readyOrder) {
    if (!pending.has(id)) continue;
    if (running.size >= maxConcurrency) break;
    const job = byId.get(id);
    const profile = workloadProfile(job);
    if ((runningByProfile.get(profile) || 0) >= workloadCap(profile)) continue;
    if (depsSatisfied(job)) {
      pending.delete(id);
      launched++;
      runningByProfile.set(profile, (runningByProfile.get(profile) || 0) + 1);
      const p = execute(job).then(result => {
        state.set(id, result);
        running.delete(id);
        runningByProfile.set(profile, Math.max(0, (runningByProfile.get(profile) || 1) - 1));
        return result;
      }, error => {
        running.delete(id);
        runningByProfile.set(profile, Math.max(0, (runningByProfile.get(profile) || 1) - 1));
        throw error;
      });
      running.set(id, p);
    } else if (depsTerminal(job)) {
      pending.delete(id);
      state.set(id, {
        id,
        type: job.type,
        status: 'BLOCKED',
        duration_ms: 0,
        blocker: 'dependency_failed',
        cache_hit: false
      });
    }
  }

  if (running.size) {
    await Promise.race(running.values());
  } else if (!launched && pending.size) {
    for (const id of pending) {
      const job = byId.get(id);
      state.set(id, {
        id,
        type: job.type,
        status: 'BLOCKED',
        duration_ms: 0,
        blocker: 'dependency_cycle_or_missing_dependency',
        cache_hit: false
      });
    }
    pending.clear();
  }
}

await cache.flush();

const results = jobs.map(j => state.get(j.id));
const output = {
  schema: 'zeibael.acker-accelerator.evidence.v3',
  task_id: packet.task_id || null,
  objective: packet.objective || null,
  mode: 'SMART_ONE_SHOT_BOUNDED_MAX_READY_PARALLEL_PERSISTENT_CACHE',
  smart_mode: packet.smart_mode,
  packet_fingerprint: packet.packet_fingerprint || null,
  advisor_kernel: packet.advisor_kernel || null,
  planner: packet.planner || null,
  input_jobs_total: compiled.diagnostics.input_jobs,
  jobs_total: jobs.length,
  duplicates_removed: compiled.diagnostics.duplicates_removed,
  transitive_dependency_edges_removed: compiled.diagnostics.transitive_dependency_edges_removed || 0,
  planner_unverified_bypassed: compiled.diagnostics.planner_unverified_bypassed || 0,
  dependency_graph_validated: compiled.diagnostics.dependency_graph_validated,
  critical_path_scheduling: compiled.diagnostics.critical_path_scheduling,
  dedupe_aliases: compiled.aliases,
  max_concurrency: maxConcurrency,
  worker_thread_ceiling_reference: WORKER_THREAD_CEILING_REFERENCE,
  webcontainer_safe_parallel_slots: WEBCONTAINER_SAFE_PARALLEL_SLOTS,
  adaptive_concurrency_cap: true,
  workload_profile_caps: WORKLOAD_CAPS,
  workload_profile_policy: 'GLOBAL_64_PLUS_PER_PROFILE_LANES',
  cache: {
    enabled: true,
    policy: 'EXPLICIT_CACHE_SAFE_ONLY',
    hits: cacheHits,
    misses: cacheMisses,
    writes: cacheWrites,
    entries_after: cache.size()
  },
  pass: results.filter(x => x?.status === 'PASS').length,
  failed: results.filter(x => x?.status === 'FAILED').length,
  blocked: results.filter(x => x?.status === 'BLOCKED').length,
  duration_ms: Date.now()-startedAt,
  results
};

process.stdout.write(JSON.stringify(output, null, 2) + '\n');
const sentinel = {
  schema: 'ZEIBAEL_SMART_ONE_SHOT_SENTINEL_V1',
  task_id: output.task_id,
  packet_fingerprint: output.packet_fingerprint,
  advisor_kernel_schema: output.advisor_kernel?.schema || null,
  advisor_kernel_mode: output.advisor_kernel?.mode || null,
  external_advisor_roundtrips: output.advisor_kernel?.external_roundtrips ?? null,
  external_runtime_promoted: output.advisor_kernel?.external_runtime_promoted ?? null,
  planner_unverified_bypassed: output.planner_unverified_bypassed,
  input_jobs_total: output.input_jobs_total,
  executable_jobs_total: output.jobs_total,
  duplicates_removed: output.duplicates_removed,
  transitive_dependency_edges_removed: output.transitive_dependency_edges_removed,
  pass: output.pass,
  failed: output.failed,
  blocked: output.blocked,
  cache_hits: output.cache.hits,
  cache_misses: output.cache.misses,
  max_concurrency: output.max_concurrency,
  worker_thread_ceiling_reference: output.worker_thread_ceiling_reference,
  webcontainer_safe_parallel_slots: output.webcontainer_safe_parallel_slots,
  dependency_graph_validated: output.dependency_graph_validated,
  critical_path_scheduling: output.critical_path_scheduling,
  live_order_enabled: false
};
process.stdout.write('ZEIBAEL_SMART_ONE_SHOT=' + JSON.stringify(sentinel) + '\n');
if (output.failed || output.blocked) process.exitCode = 1;
