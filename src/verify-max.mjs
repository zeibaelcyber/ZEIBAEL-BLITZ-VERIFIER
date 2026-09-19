import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  DEFAULT_SYSTEM_HEALTH_CACHE_TTL_MS,
  isSafeSystemHealthPayload,
  readSystemHealthCache,
  writeSystemHealthCache,
} from './system-health-cache.mjs';

const started = Date.now();
const ZEIBAEL_SYSTEM_HEALTH_URL = process.env.ZEIBAEL_SYSTEM_HEALTH_URL ||
  'https://pfxcdxxxcyoinlksruoy.supabase.co/functions/v1/zeibael-blitz-health?mode=fast';
const ZEIBAEL_SYSTEM_HEALTH_CACHE_TTL_MS = Math.max(
  1,
  Number(process.env.ZEIBAEL_SYSTEM_HEALTH_CACHE_TTL_MS || DEFAULT_SYSTEM_HEALTH_CACHE_TTL_MS),
);

function failWithDetail(message, detail) {
  const error = new Error(message);
  error.zeibaelDetail = detail;
  throw error;
}

async function fetchJson(url, ms = 10000) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error(`HTTPS required: ${parsed.protocol}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
      redirect: 'follow',
    });
    const payload = await response.json().catch(() => null);
    return { response, payload, origin: parsed.origin };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSystemHealthCached() {
  const cached = await readSystemHealthCache(ZEIBAEL_SYSTEM_HEALTH_URL, {
    ttlMs: ZEIBAEL_SYSTEM_HEALTH_CACHE_TTL_MS,
  });
  if (cached) {
    const parsed = new URL(ZEIBAEL_SYSTEM_HEALTH_URL);
    return {
      response: { ok: true, status: 200 },
      payload: cached.payload,
      origin: parsed.origin,
      cache_hit: true,
      cache_age_ms: cached.age_ms,
    };
  }
  const fetched = await fetchJson(ZEIBAEL_SYSTEM_HEALTH_URL);
  if (fetched.response.ok && isSafeSystemHealthPayload(fetched.payload)) {
    await writeSystemHealthCache(ZEIBAEL_SYSTEM_HEALTH_URL, fetched.payload).catch(() => false);
  }
  return { ...fetched, cache_hit: false, cache_age_ms: null };
}

async function runCheck(name, fn, { required = true } = {}) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    return { name, required, status: 'PASS', duration_ms: Date.now() - t0, detail };
  } catch (error) {
    const detail = error && typeof error === 'object' && 'zeibaelDetail' in error
      ? error.zeibaelDetail
      : String(error?.message ?? error);
    return { name, required, status: 'FAIL', duration_ms: Date.now() - t0, detail };
  }
}

function optionalHttpCheck(name, envName) {
  const url = process.env[envName];
  if (!url) {
    return async () => ({ name, required: false, status: 'SKIP', duration_ms: 0, detail: `${envName} not configured` });
  }
  return async () => runCheck(name, async () => {
    const { response, origin } = await fetchJson(url, 8000);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { origin, status: response.status };
  }, { required: true });
}

const jobs = [
  () => runCheck('runtime.node', async () => {
    const major = Number(process.versions.node.split('.')[0]);
    if (!Number.isFinite(major) || major < 18) throw new Error(`Node ${process.versions.node} is below 18`);
    return { node: process.versions.node, platform: process.platform, arch: process.arch };
  }),

  () => runCheck('runtime.filesystem', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeibael-blitz-'));
    const file = join(dir, 'probe.txt');
    try {
      const expected = `probe-${Date.now()}`;
      await writeFile(file, expected, 'utf8');
      const actual = await readFile(file, 'utf8');
      if (actual !== expected) throw new Error('Filesystem roundtrip mismatch');
      return { roundtrip: true };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }),

  () => runCheck('runtime.subprocess', () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ZEIBAEL_OK")']);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`Subprocess exit ${code}: ${stderr}`));
      if (stdout !== 'ZEIBAEL_OK') return reject(new Error(`Unexpected subprocess output: ${stdout}`));
      resolve({ spawn: true });
    });
  })),

  () => runCheck('runtime.timer', async () => {
    const t = Date.now();
    await new Promise(resolve => setTimeout(resolve, 25));
    const elapsed = Date.now() - t;
    if (elapsed < 15) throw new Error(`Timer anomaly: ${elapsed}ms`);
    return { elapsed_ms: elapsed };
  }),

  () => runCheck('zeibael.system_health', async () => {
    const { response, payload, origin, cache_hit, cache_age_ms } = await fetchSystemHealthCached();
    const systemChecks = Array.isArray(payload?.checks)
      ? payload.checks.map(item => ({ name: item?.name, ok: item?.ok, required: item?.required, detail: item?.detail }))
      : [];
    const failed = systemChecks.filter(item => item.required !== false && item.ok !== true);
    const safeDetail = {
      origin,
      http_status: response.status,
      service: payload?.service ?? null,
      version: payload?.version ?? null,
      summary: payload?.summary ?? null,
      failed_checks: failed,
      checks: systemChecks,
      secrets_exposed: payload?.secrets_exposed,
      live_order_enabled: payload?.live_order_enabled,
      health_cache_hit: cache_hit === true,
      health_cache_age_ms: cache_age_ms,
      health_cache_ttl_ms: ZEIBAEL_SYSTEM_HEALTH_CACHE_TTL_MS,
    };
    if (!response.ok || payload?.ok !== true) failWithDetail(`ZEIBAEL health HTTP ${response.status}`, safeDetail);
    if (payload.secrets_exposed !== false) failWithDetail('Health contract did not assert secrets_exposed=false', safeDetail);
    if (payload.live_order_enabled !== false) failWithDetail('Health contract did not assert live_order_enabled=false', safeDetail);
    if (failed.length) failWithDetail(`ZEIBAEL health has ${failed.length} failed required check(s)`, safeDetail);
    return safeDetail;
  }),

  optionalHttpCheck('target.supabase.custom', 'SUPABASE_HEALTH_URL'),
  optionalHttpCheck('target.convex.custom', 'CONVEX_HEALTH_URL'),
  optionalHttpCheck('target.zeibael_canary.custom', 'ZEIBAEL_CANARY_URL'),
];

// MAX-PARALLEL policy: every independent check starts immediately.
// We do not waste time on capability calibration or artificial worker-count tests.
const checks = await Promise.all(jobs.map(job => job()));

const requiredFailures = checks.filter(c => c.required && c.status !== 'PASS');
const status = requiredFailures.length === 0 ? 'VERIFIED' : 'FAILED';
const baseEvidence = {
  schema: 'zeibael.verifier.evidence.v4',
  status,
  execution_mode: 'MAX_PARALLEL_BOUNDED_HEALTH_REUSE',
  calibration_disabled: true,
  independent_jobs_started_in_parallel: jobs.length,
  generated_at: new Date().toISOString(),
  duration_ms: Date.now() - started,
  runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
  summary: {
    pass: checks.filter(c => c.status === 'PASS').length,
    fail: checks.filter(c => c.status === 'FAIL').length,
    skip: checks.filter(c => c.status === 'SKIP').length,
    required_failures: requiredFailures.length,
  },
  blockers: requiredFailures.map(c => ({ name: c.name, detail: c.detail })),
  checks,
};

const evidenceId = createHash('sha256').update(JSON.stringify(baseEvidence)).digest('hex').slice(0, 24);
const evidence = { ...baseEvidence, evidence_id: evidenceId };

await mkdir('evidence', { recursive: true });
await writeFile('evidence/latest.json', `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} else {
  console.log('\nZEIBAEL BLITZ VERIFIER — MAX PARALLEL');
  console.log('=====================================');
  for (const item of checks) console.log(`${item.status.padEnd(8)} ${item.name} (${item.duration_ms}ms)`);
  console.log('-------------------------------------');
  console.log(`STATUS      ${status}`);
  console.log(`PARALLEL    ${jobs.length} independent jobs`);
  console.log(`EVIDENCE_ID ${evidenceId}`);
}

if (status !== 'VERIFIED') process.exitCode = 1;
