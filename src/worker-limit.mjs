import { Worker } from "node:worker_threads";

const ENDPOINT = "https://pfxcdxxxcyoinlksruoy.supabase.co/functions/v1/zeibael-blitz-worker-evidence";
const MAX_WORKERS = 700;
const EXACT_FROM = 385;
const READY_TIMEOUT_MS = 5000;
const STABILITY_MS = 25;
const benchmarkId = `blitz-worker-limit-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
const workers = [];
const states = [];

async function post(event, worker_n = null, payload = {}) {
  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ benchmark_id: benchmarkId, event, worker_n, payload }),
    });
    if (!r.ok) throw new Error("collector_http_" + r.status);
  } catch (e) {
    console.error("EVIDENCE_POST_FAILED", event, worker_n, String(e?.message || e));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnOne(n) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let w;
    try {
      w = new Worker(
        `const { parentPort } = require("node:worker_threads");
         parentPort.postMessage("ready");
         Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);`,
        { eval: true }
      );
    } catch (e) {
      reject(new Error("constructor:" + (e?.message || e)));
      return;
    }

    const state = { n, alive: true, ready: false, threadId: w.threadId, exitCode: null };
    workers.push(w);
    states.push(state);

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("ready_timeout"));
      }
    }, READY_TIMEOUT_MS);

    w.once("message", (msg) => {
      if (msg === "ready" && !settled) {
        settled = true;
        clearTimeout(timer);
        state.ready = true;
        state.threadId = w.threadId;
        resolve(state);
      }
    });

    w.once("error", (err) => {
      state.alive = false;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error("worker_error:" + (err?.message || err)));
      }
    });

    w.once("exit", (code) => {
      state.alive = false;
      state.exitCode = code;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error("exit_before_ready:" + code));
      }
    });
  });
}

function aliveReadyCount() {
  return states.filter((s) => s.ready && s.alive).length;
}

function allPriorAlive(expected) {
  return aliveReadyCount() === expected;
}

async function terminateAll() {
  await Promise.allSettled(workers.map((w) => w.terminate()));
}

const runtime = {
  node: process.version,
  versions: process.versions,
  platform: process.platform,
  arch: process.arch,
  pid: process.pid,
};

console.log("ZEIBAEL_BLITZ_WORKER_LIMIT_BEGIN", JSON.stringify({ benchmarkId, runtime, max: MAX_WORKERS, exactFrom: EXACT_FROM }));
await post("begin", 0, { runtime, max_workers: MAX_WORKERS, exact_from: EXACT_FROM });

let lastStable = 0;
let firstFailed = null;
let failure = null;

for (let n = 1; n <= MAX_WORKERS; n++) {
  if (!allPriorAlive(n - 1)) {
    firstFailed = n;
    failure = "prior_worker_died_before_attempt";
    await post("failure", n, { last_stable: lastStable, reason: failure, alive_ready: aliveReadyCount() });
    break;
  }

  if (n >= EXACT_FROM) {
    await post("attempt", n, { last_stable: lastStable, alive_ready: aliveReadyCount() });
  } else if (n % 32 === 1) {
    await post("attempt_checkpoint", n, { last_stable: lastStable, alive_ready: aliveReadyCount() });
  }

  try {
    await spawnOne(n);
    await sleep(STABILITY_MS);

    if (!allPriorAlive(n)) {
      throw new Error("worker_died_during_stability_window");
    }

    lastStable = n;
    if (n >= EXACT_FROM) {
      await post("stable", n, { alive_ready: aliveReadyCount(), rss: process.memoryUsage().rss });
    } else if (n % 32 === 0) {
      await post("stable_checkpoint", n, { alive_ready: aliveReadyCount(), rss: process.memoryUsage().rss });
    }

    if (n % 25 === 0 || n >= EXACT_FROM) {
      console.log("STABLE", n);
    }
  } catch (e) {
    firstFailed = n;
    failure = String(e?.message || e);
    await post("failure", n, {
      last_stable: lastStable,
      reason: failure,
      alive_ready: aliveReadyCount(),
      rss: process.memoryUsage().rss,
    });
    console.error("FIRST_FAILURE", n, failure);
    break;
  }
}

const status = firstFailed === null ? "LOWER_BOUND_ONLY" : "EXACT_BOUNDARY_OBSERVED";
const result = {
  schema: "zeibael.blitz.worker_limit.v1",
  benchmark_id: benchmarkId,
  status,
  max_stable_workers: lastStable,
  first_failed_worker: firstFailed,
  failure,
  max_tested: firstFailed ?? MAX_WORKERS,
  runtime,
};

await post("final", firstFailed ?? lastStable, result);
console.log("ZEIBAEL_BLITZ_WORKER_LIMIT_RESULT=" + JSON.stringify(result));
await terminateAll();
