import { Worker } from "node:worker_threads";

const ENDPOINT = "https://pfxcdxxxcyoinlksruoy.supabase.co/functions/v1/zeibael-blitz-worker-evidence";
const MAX_WORKERS = 700;
const READY_TIMEOUT_MS = 4000;
const PING_TIMEOUT_MS = 5000;
const HOLD_MS = 1500;
const CHECKPOINT_EVERY = 8;
const CONFIRM_ROUNDS = 2;
const benchmarkId = `blitz-worker-limit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const workerSource = `
  const { parentPort } = require("node:worker_threads");
  parentPort.on("message", (msg) => {
    if (msg && msg.type === "ping") {
      let x = msg.seed >>> 0;
      for (let i = 0; i < 2000; i++) x = Math.imul(x ^ (i + 1), 2654435761) >>> 0;
      parentPort.postMessage({ type: "pong", id: msg.id, x });
    }
  });
  parentPort.postMessage({ type: "ready" });
`;

async function post(event, worker_n, payload = {}) {
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

async function spawnOne(n, pool) {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let w;
    try {
      w = new Worker(workerSource, { eval: true });
    } catch (e) {
      reject(new Error("constructor:" + (e?.message || e)));
      return;
    }

    const state = { n, worker: w, ready: false, alive: true, threadId: w.threadId, exitCode: null };
    pool.push(state);

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("ready_timeout"));
      }
    }, READY_TIMEOUT_MS);

    w.once("message", (msg) => {
      if (msg?.type === "ready" && !settled) {
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

function liveReady(pool) {
  return pool.filter((s) => s.ready && s.alive);
}

async function pingAll(pool, round) {
  const live = liveReady(pool);
  const pending = new Map();
  let seq = 0;

  await Promise.all(live.map((s) => new Promise((resolve, reject) => {
    const id = `${round}-${seq++}-${s.threadId}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("ping_timeout_thread_" + s.threadId));
    }, PING_TIMEOUT_MS);

    const onMessage = (msg) => {
      if (msg?.type === "pong" && msg.id === id) {
        clearTimeout(timer);
        pending.delete(id);
        s.worker.off("message", onMessage);
        resolve();
      }
    };
    pending.set(id, true);
    s.worker.on("message", onMessage);
    s.worker.postMessage({ type: "ping", id, seed: (s.n * 1009 + round * 9176) >>> 0 });
  })));

  return live.length;
}

async function terminateAll(pool) {
  await Promise.allSettled(pool.map((s) => s.worker.terminate()));
  pool.length = 0;
  await sleep(250);
}

async function capacityRun(target = MAX_WORKERS, label = "discovery") {
  const pool = [];
  let lastStable = 0;
  let firstFailed = null;
  let failure = null;

  for (let n = 1; n <= target; n++) {
    if (liveReady(pool).length !== n - 1) {
      firstFailed = n;
      failure = "prior_worker_died_before_attempt";
      break;
    }

    if (n === 1 || n % CHECKPOINT_EVERY === 0 || n >= 350) {
      await post("attempt_checkpoint", n, {
        label,
        last_stable: lastStable,
        alive_ready: liveReady(pool).length,
        rss: process.memoryUsage().rss,
      });
    }

    try {
      await spawnOne(n, pool);
      lastStable = n;

      if (n % CHECKPOINT_EVERY === 0 || n >= 350) {
        await post("stable_checkpoint", n, {
          label,
          alive_ready: liveReady(pool).length,
          rss: process.memoryUsage().rss,
        });
        console.log("STABLE", label, n);
      }
    } catch (e) {
      firstFailed = n;
      failure = String(e?.message || e);
      break;
    }
  }

  if (firstFailed === null) {
    try {
      const pong = await pingAll(pool, 1);
      await sleep(HOLD_MS);
      if (liveReady(pool).length !== lastStable) throw new Error("worker_died_during_hold");
      console.log("LOWER_BOUND", label, lastStable, "all_pong", pong);
    } catch (e) {
      firstFailed = lastStable;
      failure = "stability:" + String(e?.message || e);
      lastStable = Math.max(0, liveReady(pool).length);
    }
  } else {
    try {
      const pong = await pingAll(pool, 1);
      await sleep(HOLD_MS);
      if (liveReady(pool).length !== lastStable) throw new Error("worker_died_during_hold");
      console.log("BOUNDARY_DISCOVERED", label, { lastStable, firstFailed, pong });
    } catch (e) {
      failure = (failure ? failure + "|" : "") + "stability:" + String(e?.message || e);
      lastStable = liveReady(pool).length;
    }
  }

  const result = {
    label,
    lastStable,
    firstFailed,
    failure,
    rss: process.memoryUsage().rss,
  };

  if (firstFailed !== null) {
    await post("failure", firstFailed, {
      label,
      last_stable: lastStable,
      reason: failure,
      alive_ready: liveReady(pool).length,
      rss: result.rss,
    });
  }

  await terminateAll(pool);
  return result;
}

async function exactProbe(target, shouldPass, round, label) {
  const pool = [];
  let spawned = 0;
  let error = null;

  await post("boundary_probe", target, { should_pass: shouldPass, round, label });

  try {
    for (let n = 1; n <= target; n++) {
      await spawnOne(n, pool);
      spawned = n;
    }
    const pong = await pingAll(pool, 100 + round);
    await sleep(HOLD_MS);
    if (liveReady(pool).length !== target) {
      throw new Error("worker_died_during_hold");
    }

    const passed = true;
    await post("boundary_pass", target, {
      should_pass: shouldPass,
      round,
      label,
      spawned,
      pong,
      rss: process.memoryUsage().rss,
    });
    return { target, shouldPass, passed, spawned, error: null };
  } catch (e) {
    error = String(e?.message || e);
    await post("boundary_fail", target, {
      should_pass: shouldPass,
      round,
      label,
      spawned,
      error,
      alive_ready: liveReady(pool).length,
      rss: process.memoryUsage().rss,
    });
    return { target, shouldPass, passed: false, spawned, error };
  } finally {
    await terminateAll(pool);
  }
}

const runtime = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  pid: process.pid,
  versions: process.versions,
};

console.log("ZEIBAEL_BLITZ_WORKER_LIMIT_BEGIN", JSON.stringify({
  benchmarkId,
  runtime,
  max: MAX_WORKERS,
  confirmRounds: CONFIRM_ROUNDS,
}));

await post("begin", 0, {
  runtime,
  max_workers: MAX_WORKERS,
  confirm_rounds: CONFIRM_ROUNDS,
  definition: "simultaneously alive node:worker_threads workers, each ready + ping/pong operational + hold window",
});

const discovery = await capacityRun(MAX_WORKERS, "discovery");
let candidate = discovery.lastStable;
let firstFailed = discovery.firstFailed;
const confirmations = [];
let exact = false;
let variability = false;

if (firstFailed !== null && candidate >= 0) {
  for (let round = 1; round <= CONFIRM_ROUNDS; round++) {
    const good = await exactProbe(candidate, true, round, "candidate");
    const bad = await exactProbe(candidate + 1, false, round, "candidate_plus_one");
    confirmations.push({ round, good, bad });

    if (!good.passed || bad.passed) {
      variability = true;
      if (bad.passed) {
        console.log("BOUNDARY_MOVED_UP", candidate + 1, "round", round);
        const extension = await capacityRun(Math.min(MAX_WORKERS, candidate + 64), "extension");
        if (extension.lastStable > candidate) {
          candidate = extension.lastStable;
          firstFailed = extension.firstFailed;
        }
      }
    }
  }

  exact = confirmations.length === CONFIRM_ROUNDS &&
    confirmations.every((c) => c.good.target === candidate && c.good.passed && c.bad.target === candidate + 1 && !c.bad.passed);
}

const status = exact
  ? "EXACT_SESSION_BOUNDARY_CONFIRMED"
  : firstFailed === null
    ? "LOWER_BOUND_ONLY"
    : variability
      ? "SESSION_VARIABILITY_OBSERVED"
      : "BOUNDARY_OBSERVED_NOT_CONFIRMED";

const result = {
  schema: "zeibael.blitz.worker_limit.v2",
  benchmark_id: benchmarkId,
  status,
  max_stable_workers: candidate,
  first_failed_worker: exact ? candidate + 1 : firstFailed,
  discovery,
  confirmations,
  runtime,
  test_definition: {
    worker_type: "node:worker_threads.Worker",
    simultaneously_alive: true,
    ready_required: true,
    ping_pong_required: true,
    hold_ms: HOLD_MS,
    confirm_rounds: CONFIRM_ROUNDS,
    max_workers_tested: MAX_WORKERS,
  },
};

await post("final", result.first_failed_worker ?? result.max_stable_workers, result);
console.log("ZEIBAEL_BLITZ_WORKER_LIMIT_RESULT=" + JSON.stringify(result));
process.exit(status === "EXACT_SESSION_BOUNDARY_CONFIRMED" ? 0 : 2);
