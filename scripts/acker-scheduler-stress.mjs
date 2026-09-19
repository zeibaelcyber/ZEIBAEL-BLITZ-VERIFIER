import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const TOTAL = 4096;
const profiles = ['LIGHT','IO','BUILD_TEST','CPU_HEAVY'];
const jobs = [];

for (let i = 0; i < 2048; i++) {
  jobs.push({ id: 'root-' + i, type: 'inline', workload_profile: profiles[i % 4], code: 'return ' + i });
}
for (let i = 0; i < 1024; i++) {
  jobs.push({ id: 'mid-' + i, type: 'inline', workload_profile: profiles[(i + 1) % 4], depends_on: ['root-' + i], code: 'return ' + (3000 + i) });
}
for (let i = 0; i < 512; i++) {
  jobs.push({ id: 'deep-' + i, type: 'inline', workload_profile: profiles[(i + 2) % 4], depends_on: ['mid-' + i], code: 'return ' + (5000 + i) });
}
for (let i = 0; i < 512; i++) {
  jobs.push({ id: 'final-' + i, type: 'inline', workload_profile: profiles[(i + 3) % 4], depends_on: ['deep-' + i, 'root-' + (1024 + i)], code: 'return ' + (7000 + i) });
}
if (jobs.length !== TOTAL) throw new Error('STRESS_JOB_COUNT_MISMATCH');

const dir = await mkdtemp(path.join(tmpdir(), 'zeibael-acker-stress-'));
const packetPath = path.join(dir, 'packet.json');
await writeFile(packetPath, JSON.stringify({
  task_id: 'acker-scheduler-stress-4096',
  objective: 'Validate event-driven scheduler at max packet size',
  max_concurrency: 64,
  jobs
}));

const started = Date.now();
const child = spawn(process.execPath, ['src/acker-accelerator.mjs', packetPath], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ZEIBAEL_MAX_CONCURRENCY: '64' }
});

let sentinel = null;
let stderr = '';
const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
rl.on('line', line => {
  if (line.startsWith('ZEIBAEL_SMART_ONE_SHOT=')) {
    sentinel = JSON.parse(line.slice('ZEIBAEL_SMART_ONE_SHOT='.length));
  }
});
child.stderr.on('data', d => {
  stderr += d.toString();
  if (stderr.length > 12000) stderr = stderr.slice(-12000);
});

const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', resolve);
});
await rm(dir, { recursive: true, force: true });

if (exitCode !== 0) throw new Error('STRESS_CHILD_FAILED:' + exitCode + ':' + stderr);
if (!sentinel) throw new Error('STRESS_SENTINEL_MISSING');
if (sentinel.executable_jobs_total !== TOTAL) throw new Error('STRESS_EXECUTABLE_COUNT_MISMATCH');
if (sentinel.pass !== TOTAL || sentinel.failed !== 0 || sentinel.blocked !== 0) throw new Error('STRESS_RESULT_INVALID:' + JSON.stringify(sentinel));
if (sentinel.max_concurrency !== 64) throw new Error('STRESS_CONCURRENCY_NOT_64:' + sentinel.max_concurrency);

const evidence = {
  schema: 'zeibael.acker.scheduler-stress.v1',
  ok: true,
  jobs: TOTAL,
  dependency_layers: 4,
  mixed_profiles: profiles,
  max_concurrency: sentinel.max_concurrency,
  pass: sentinel.pass,
  failed: sentinel.failed,
  blocked: sentinel.blocked,
  dependency_graph_validated: sentinel.dependency_graph_validated,
  critical_path_scheduling: sentinel.critical_path_scheduling,
  wall_ms: Date.now() - started,
  live_order_enabled: false
};
process.stdout.write('ZEIBAEL_ACKER_SCHEDULER_STRESS=' + JSON.stringify(evidence) + '\n');
