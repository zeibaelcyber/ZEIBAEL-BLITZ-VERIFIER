import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const started = Date.now();
const checks = [];
const ZEIBAEL_SYSTEM_HEALTH_URL = process.env.ZEIBAEL_SYSTEM_HEALTH_URL ||
  'https://pfxcdxxxcyoinlksruoy.supabase.co/functions/v1/zeibael-blitz-health';

async function check(name, fn, { required = true } = {}) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    checks.push({ name, required, status: 'PASS', duration_ms: Date.now() - t0, detail });
  } catch (error) {
    checks.push({
      name,
      required,
      status: 'FAIL',
      duration_ms: Date.now() - t0,
      detail: String(error?.message ?? error),
    });
  }
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

async function configuredHttp(name, envName) {
  const url = process.env[envName];
  if (!url) {
    checks.push({ name, required: false, status: 'SKIP', duration_ms: 0, detail: `${envName} not configured` });
    return;
  }

  await check(name, async () => {
    const { response, origin } = await fetchJson(url, 8000);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { origin, status: response.status };
  }, { required: true });
}

await check('runtime.node', async () => {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(major) || major < 18) throw new Error(`Node ${process.versions.node} is below 18`);
  return { node: process.versions.node, platform: process.platform, arch: process.arch };
});

await check('runtime.filesystem', async () => {
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
});

await check('runtime.subprocess', () => new Promise((resolve, reject) => {
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
}));

await check('runtime.timer', async () => {
  const t = Date.now();
  await new Promise(resolve => setTimeout(resolve, 25));
  const elapsed = Date.now() - t;
  if (elapsed < 15) throw new Error(`Timer anomaly: ${elapsed}ms`);
  return { elapsed_ms: elapsed };
});

await check('zeibael.system_health', async () => {
  const { response, payload, origin } = await fetchJson(ZEIBAEL_SYSTEM_HEALTH_URL);
  if (!response.ok) throw new Error(`Health HTTP ${response.status}`);
  if (!payload || payload.ok !== true) throw new Error('ZEIBAEL health returned ok=false');
  if (payload.secrets_exposed !== false) throw new Error('Health contract did not assert secrets_exposed=false');
  if (payload.live_order_enabled !== false) throw new Error('Health contract did not assert live_order_enabled=false');
  const failed = Array.isArray(payload.checks) ? payload.checks.filter(item => item?.ok !== true) : [];
  if (failed.length) throw new Error(`ZEIBAEL health has ${failed.length} failed check(s)`);
  return {
    origin,
    service: payload.service,
    version: payload.version,
    summary: payload.summary,
    checks: Array.isArray(payload.checks)
      ? payload.checks.map(item => ({ name: item.name, ok: item.ok, detail: item.detail }))
      : [],
  };
});

await configuredHttp('target.supabase.custom', 'SUPABASE_HEALTH_URL');
await configuredHttp('target.convex.custom', 'CONVEX_HEALTH_URL');
await configuredHttp('target.zeibael_canary.custom', 'ZEIBAEL_CANARY_URL');

const requiredFailures = checks.filter(c => c.required && c.status !== 'PASS');
const status = requiredFailures.length === 0 ? 'VERIFIED' : 'FAILED';
const baseEvidence = {
  schema: 'zeibael.verifier.evidence.v2',
  status,
  generated_at: new Date().toISOString(),
  duration_ms: Date.now() - started,
  runtime: {
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  },
  summary: {
    pass: checks.filter(c => c.status === 'PASS').length,
    fail: checks.filter(c => c.status === 'FAIL').length,
    skip: checks.filter(c => c.status === 'SKIP').length,
    required_failures: requiredFailures.length,
  },
  checks,
};

const evidenceId = createHash('sha256').update(JSON.stringify(baseEvidence)).digest('hex').slice(0, 24);
const evidence = { ...baseEvidence, evidence_id: evidenceId };

await mkdir('evidence', { recursive: true });
await writeFile('evidence/latest.json', `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} else {
  console.log('\nZEIBAEL BLITZ VERIFIER');
  console.log('======================');
  for (const item of checks) {
    console.log(`${item.status.padEnd(8)} ${item.name} (${item.duration_ms}ms)`);
  }
  console.log('----------------------');
  console.log(`STATUS      ${status}`);
  console.log(`EVIDENCE_ID ${evidenceId}`);
  console.log('Evidence written to evidence/latest.json');
}

if (status !== 'VERIFIED') process.exitCode = 1;
