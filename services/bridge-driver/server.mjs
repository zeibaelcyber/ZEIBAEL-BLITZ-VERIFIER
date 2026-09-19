import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const HARD_TASK_CEILING = 4096;
const PROVEN_WORKER_CEILING = 1791;
const DEFAULT_MAX_CONCURRENCY = 64;
const MAX_TASKS = Math.max(1, Math.min(HARD_TASK_CEILING, Number(process.env.ZEIBAEL_MAX_TASKS) || HARD_TASK_CEILING));
const MAX_CONCURRENCY = Math.max(1, Math.min(PROVEN_WORKER_CEILING, Number(process.env.ZEIBAEL_MAX_CONCURRENCY) || DEFAULT_MAX_CONCURRENCY));
const MAX_CODE_BYTES = 64 * 1024;
const MAX_TOTAL_CODE_BYTES = 8 * 1024 * 1024;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TASK_TIMEOUT_MS = 15_000;
const PROFILE_CAPS = Object.freeze({ LIGHT: 18, IO: 29, BUILD_TEST: 32, CPU_HEAVY: 39 });
function profileCap(value) {
  const p = String(value || '').toUpperCase();
  return { profile: Object.prototype.hasOwnProperty.call(PROFILE_CAPS, p) ? p : 'GENERIC', cap: Object.prototype.hasOwnProperty.call(PROFILE_CAPS, p) ? PROFILE_CAPS[p] : MAX_CONCURRENCY };
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(body));
}

function html(res) {
  const body = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>ZEIBAEL Blitz Bridge Driver</title></head>
<body>
  <div id="status">READY</div>
  <script>
    window.zeibaelProbe = () => ({
      ready: document.getElementById('status')?.textContent === 'READY',
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      sharedArrayBuffer: typeof SharedArrayBuffer,
      secureContext: globalThis.isSecureContext === true,
      lane: 'STACKBLITZ_WEBCONTAINER_BRIDGE_DRIVER_V1'
    });
    window.zeibaelRun = async (payload) => {
      const response = await fetch('/run', {
        method: 'POST',
        headers: {'content-type':'application/json'},
        body: JSON.stringify(payload || {})
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.code || value?.error || 'RUN_FAILED');
      return value;
    };
  </script>
</body>
</html>`;
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function safeId(value, fallback) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : fallback;
}

function normalizeTasks(body) {
  const tasks = Array.isArray(body?.tasks) ? body.tasks : [];
  if (tasks.length < 1 || tasks.length > MAX_TASKS) {
    throw new Error('TASK_COUNT_1_TO_'+MAX_TASKS+'_REQUIRED');
  }

  let total = 0;
  const normalized = tasks.map((task, index) => {
    const code = typeof task?.code === 'string' ? task.code : '';
    if (!code) throw new Error(`CODE_REQUIRED:${index}`);
    const bytes = Buffer.byteLength(code, 'utf8');
    if (bytes > MAX_CODE_BYTES) throw new Error(`TASK_CODE_TOO_LARGE:${index}`);
    total += bytes;
    return { id: safeId(task?.id, `task-${index + 1}`), code };
  });
  if (total > MAX_TOTAL_CODE_BYTES) throw new Error('TOTAL_CODE_TOO_LARGE');
  return normalized;
}

function clampConcurrency(value, taskCount, workloadProfile) {
  const selected = profileCap(workloadProfile);
  const n = Number(value);
  const requested = Number.isFinite(n) ? Math.floor(n) : taskCount;
  return { concurrency: Math.max(1, Math.min(taskCount, requested, MAX_CONCURRENCY, selected.cap)), selected };
}

function truncateBuffer(buffer) {
  if (buffer.length <= MAX_OUTPUT_BYTES) return buffer.toString('utf8');
  return Buffer.concat([
    buffer.subarray(0, MAX_OUTPUT_BYTES),
    Buffer.from('\n...[truncated]')
  ]).toString('utf8');
}

function runOne(task) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--input-type=module', '--eval', task.code], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH || '',
        HOME: process.env.HOME || '',
        LANG: process.env.LANG || 'C.UTF-8',
        ZEIBAEL_MODE: 'RESEARCH_VALIDATION',
        ZEIBAEL_LIVE_ORDER_ENABLED: 'false'
      }
    });

    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;

    child.stdout.on('data', (chunk) => {
      if (outBytes < MAX_OUTPUT_BYTES) out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr.on('data', (chunk) => {
      if (errBytes < MAX_OUTPUT_BYTES) err.push(chunk);
      errBytes += chunk.length;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, DEFAULT_TASK_TIMEOUT_MS);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const stdout = truncateBuffer(Buffer.concat(out));
      const stderr = truncateBuffer(Buffer.concat(err));
      resolve({
        id: task.id,
        ok: code === 0 && !timedOut,
        exit_code: code,
        signal,
        timed_out: timedOut,
        elapsed_ms: Date.now() - started,
        output: stdout,
        error: stderr || null
      });
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        id: task.id,
        ok: false,
        exit_code: null,
        signal: null,
        timed_out: false,
        elapsed_ms: Date.now() - started,
        output: '',
        error: String(error?.message || error)
      });
    });
  });
}

async function runPool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= tasks.length) return;
      results[index] = await runOne(tasks[index]);
    }
  }

  const count = Math.min(concurrency, tasks.length);
  await Promise.all(Array.from({ length: count }, () => worker()));
  return results;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    if (req.url === '/') return html(res);
    return sendJson(res, 200, {
      ok: true,
      lane: 'STACKBLITZ_WEBCONTAINER_BRIDGE_DRIVER_V1',
      engine: 'STACKBLITZ_WEBCONTAINER',
      mode: 'RESEARCH_VALIDATION',
      live_order_enabled: false,
      max_tasks: MAX_TASKS,
      max_concurrency: MAX_CONCURRENCY,
      proven_worker_ceiling: PROVEN_WORKER_CEILING,
      adaptive_concurrency: true,
      profile_caps: PROFILE_CAPS,
      max_code_bytes: MAX_CODE_BYTES,
      max_total_code_bytes: MAX_TOTAL_CODE_BYTES
    });
  }

  if (req.method !== 'POST' || req.url !== '/run') {
    return sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
  }

  const started = Date.now();
  try {
    const body = await readJson(req);
    const tasks = normalizeTasks(body);
    const { concurrency, selected } = clampConcurrency(body?.concurrency, tasks.length, body?.workload_profile);
    const results = await runPool(tasks, concurrency);

    return sendJson(res, 200, {
      ok: results.every((item) => item.ok),
      lane: 'STACKBLITZ_WEBCONTAINER_BRIDGE_DRIVER_V1',
      engine: 'STACKBLITZ_WEBCONTAINER',
      mode: 'RESEARCH_VALIDATION',
      live_order_enabled: false,
      zero_spend_required: true,
      requested_tasks: tasks.length,
      requested_concurrency: Number(body?.concurrency) || null,
      actual_concurrency: concurrency,
      max_concurrency: MAX_CONCURRENCY,
      workload_profile: selected.profile,
      profile_cap: selected.cap,
      compute_elapsed_ms: Date.now() - started,
      results
    });
  } catch (error) {
    const code = String(error?.message || error);
    const status = code === 'BODY_TOO_LARGE' || code.includes('TOO_LARGE') ? 413 : 400;
    return sendJson(res, status, {
      ok: false,
      code,
      lane: 'STACKBLITZ_WEBCONTAINER_BRIDGE_DRIVER_V1',
      live_order_enabled: false
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({
    event: 'ready',
    lane: 'STACKBLITZ_WEBCONTAINER_BRIDGE_DRIVER_V1',
    host: HOST,
    port: PORT,
    live_order_enabled: false
  }));
});
