import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = await mkdtemp(join(tmpdir(), 'zeibael-blitz-cache-test-'));
const packetPath = join(root, 'packet.json');
const cacheDir = join(root, 'cache');
const packet = {
  task_id: 'blitz-free-fabric-selftest-v1',
  objective: 'prove persistent cache reuse across accelerator invocations',
  max_concurrency: 3,
  cache_ttl_ms: 60000,
  jobs: [
    { id: 'cache-a', type: 'inline', cache_safe: true, code: "await new Promise(r=>setTimeout(r,250)); return 'A'" },
    { id: 'cache-b', type: 'inline', cache_safe: true, code: "await new Promise(r=>setTimeout(r,250)); return 'B'" },
    { id: 'always-run', type: 'inline', cache_safe: false, code: "return 'C'" }
  ]
};
await writeFile(packetPath, JSON.stringify(packet), 'utf8');

function runOnce() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/acker-accelerator.mjs', packetPath], {
      cwd: process.cwd(),
      env: { ...process.env, ZEIBAEL_BLITZ_CACHE_DIR: cacheDir },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(stderr || stdout || `exit_${code}`));
      const marker = '\nZEIBAEL_SMART_ONE_SHOT=';
      const idx = stdout.indexOf(marker);
      if (idx < 0) return reject(new Error('missing_sentinel'));
      try { resolve(JSON.parse(stdout.slice(0, idx))); }
      catch (error) { reject(error); }
    });
  });
}

try {
  const first = await runOnce();
  const second = await runOnce();
  const ok =
    first.pass === 3 && second.pass === 3 &&
    first.cache?.hits === 0 && first.cache?.writes === 2 &&
    second.cache?.hits === 2 && second.cache?.writes === 0 &&
    second.results?.filter(x => x?.cache_hit === true).length === 2;
  const evidence = {
    schema: 'zeibael.blitz.free-fabric-selftest.v1',
    ok,
    first: { duration_ms: first.duration_ms, cache: first.cache },
    second: { duration_ms: second.duration_ms, cache: second.cache },
    live_order_enabled: false
  };
  console.log('BLITZ_FREE_FABRIC_SELFTEST=' + JSON.stringify(evidence));
  if (!ok) process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
