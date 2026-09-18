import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node src/acker-accelerator.mjs <packet.json>');
  process.exit(2);
}

const packet = JSON.parse(await readFile(inputPath, 'utf8'));
const jobs = Array.isArray(packet.jobs) ? packet.jobs : [];
const byId = new Map(jobs.map(j => [j.id, j]));
const state = new Map();
const startedAt = Date.now();
const WORKER_THREAD_CEILING = 1791;
const requestedConcurrency = Number(packet.max_concurrency ?? packet.concurrency ?? jobs.length);
const maxConcurrency =
  Number.isFinite(requestedConcurrency) && requestedConcurrency >= 1
    ? Math.min(WORKER_THREAD_CEILING, Math.floor(requestedConcurrency))
    : Math.min(WORKER_THREAD_CEILING, Math.max(1, jobs.length));

function safeText(v, max = 12000) {
  const s = String(v ?? '');
  return s.length > max ? s.slice(-max) : s;
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

async function execute(job) {
  if (job.type === 'command') return runCommand(job);
  if (job.type === 'http') return runHttp(job);
  if (job.type === 'inline') return runInline(job);
  return { id: job.id, type: job.type, status: 'FAILED', duration_ms: 0, error: 'unsupported_job_type' };
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

while (pending.size || running.size) {
  let launched = 0;

  for (const id of [...pending]) {
    if (running.size >= maxConcurrency) break;
    const job = byId.get(id);
    if (depsSatisfied(job)) {
      pending.delete(id);
      launched++;
      const p = execute(job).then(result => {
        state.set(id, result);
        running.delete(id);
        return result;
      });
      running.set(id, p);
    } else if (depsTerminal(job)) {
      pending.delete(id);
      state.set(id, {
        id,
        type: job.type,
        status: 'BLOCKED',
        duration_ms: 0,
        blocker: 'dependency_failed'
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
        blocker: 'dependency_cycle_or_missing_dependency'
      });
    }
    pending.clear();
  }
}

const results = jobs.map(j => state.get(j.id));
const output = {
  schema: 'zeibael.acker-accelerator.evidence.v1',
  task_id: packet.task_id || null,
  objective: packet.objective || null,
  mode: 'BOUNDED_MAX_READY_PARALLEL',
  jobs_total: jobs.length,
  max_concurrency: maxConcurrency,
  worker_thread_ceiling_reference: WORKER_THREAD_CEILING,
  pass: results.filter(x => x?.status === 'PASS').length,
  failed: results.filter(x => x?.status === 'FAILED').length,
  blocked: results.filter(x => x?.status === 'BLOCKED').length,
  duration_ms: Date.now()-startedAt,
  results
};

process.stdout.write(JSON.stringify(output, null, 2) + '\n');
if (output.failed || output.blocked) process.exitCode = 1;
