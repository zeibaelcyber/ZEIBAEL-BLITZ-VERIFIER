import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 3000);
const MAX_TASKS = 128;
const MAX_CODE_BYTES = 12 * 1024;
const MAX_TOTAL_CODE_BYTES = 256 * 1024;
const MAX_CONCURRENCY = 64;
const TASK_TIMEOUT_MS = 30_000;
const ROOT = '/tmp/zeibael-blitz-runtime';

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(text);
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 512 * 1024) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function normalizeTasks(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TASKS) {
    throw new Error('TASK_COUNT_1_TO_128_REQUIRED');
  }
  let total = 0;
  return value.map((task, index) => {
    const id = typeof task?.id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(task.id)
      ? task.id
      : 'task-' + (index + 1);
    const code = typeof task?.code === 'string' ? task.code : '';
    const bytes = Buffer.byteLength(code, 'utf8');
    if (!code) throw new Error('CODE_REQUIRED:' + id);
    if (bytes > MAX_CODE_BYTES) throw new Error('TASK_CODE_TOO_LARGE:' + id);
    total += bytes;
    if (total > MAX_TOTAL_CODE_BYTES) throw new Error('TOTAL_CODE_TOO_LARGE');
    return { id, code };
  });
}

async function collect(child, timeoutMs) {
  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, exit_code: null, timeout: true, stdout, stderr });
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout = (stdout + d).slice(-16000); });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-16000); });
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, exit_code: null, timeout: false, stdout, stderr, error: String(e.message || e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, exit_code: code, timeout: false, stdout, stderr });
    });
  });
}

async function runTasks(tasks, requestedConcurrency) {
  const batchId = 'batch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const dir = join(ROOT, batchId);
  await mkdir(dir, { recursive: true });
  try {
    await Promise.all(tasks.map((task, i) => writeFile(join(dir, 'task-' + (i + 1) + '.mjs'), task.code, 'utf8')));
    const concurrency = Math.max(1, Math.min(Number(requestedConcurrency) || tasks.length, tasks.length, MAX_CONCURRENCY));
    const results = new Array(tasks.length);
    let cursor = 0;
    const started = Date.now();

    async function worker() {
      while (true) {
        const i = cursor++;
        if (i >= tasks.length) return;
        const task = tasks[i];
        const t0 = Date.now();
        const child = spawn(process.execPath, [join(dir, 'task-' + (i + 1) + '.mjs')], {
          cwd: dir,
          env: {
            PATH: process.env.PATH || '',
            HOME: process.env.HOME || '',
            NODE_ENV: 'test',
            ZEIBAEL_BLITZ: '1',
            ZEIBAEL_LIVE_ORDER_ENABLED: 'false',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const r = await collect(child, TASK_TIMEOUT_MS);
        results[i] = { id: task.id, elapsed_ms: Date.now() - t0, ...r };
      }
    }

    await Promise.all(Array.from({ length: concurrency }, worker));
    return {
      ok: results.every((x) => x?.ok === true),
      schema: 'zeibael.blitz.runtime.v1',
      runtime: 'STACKBLITZ_WEBCONTAINER',
      batch_id: batchId,
      tasks: tasks.length,
      concurrency,
      elapsed_ms: Date.now() - started,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      zero_spend_required: true,
      live_order_enabled: false,
      baseline_lock: 'BO-ABSORPTION-1H-P1000-v1.0',
      results,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, {
      ok: true,
      schema: 'zeibael.blitz.runtime.health.v1',
      runtime: 'STACKBLITZ_WEBCONTAINER',
      node: process.version,
      max_tasks: MAX_TASKS,
      max_concurrency: MAX_CONCURRENCY,
      zero_spend_required: true,
      live_order_enabled: false,
    });
  }
  if (req.method !== 'POST' || req.url !== '/run') return json(res, 404, { ok: false, error: 'not_found' });

  try {
    const payload = await body(req);
    const tasks = normalizeTasks(payload.tasks);
    const result = await runTasks(tasks, payload.concurrency);
    return json(res, result.ok ? 200 : 422, result);
  } catch (e) {
    return json(res, 400, {
      ok: false,
      schema: 'zeibael.blitz.runtime.v1',
      error: String(e?.message || e),
      zero_spend_required: true,
      live_order_enabled: false,
    });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({
    event: 'ZEIBAEL_BLITZ_RUNTIME_READY',
    port: PORT,
    runtime: 'STACKBLITZ_WEBCONTAINER',
    node: process.version,
    zero_spend_required: true,
    live_order_enabled: false,
  }));
});
