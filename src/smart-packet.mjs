import { createHash } from "node:crypto";

const JOB_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => [key, stableObject(val)])
  );
}

function jobSemanticShape(job) {
  const base = { type: job.type };
  if (job.type === "command") {
    return {
      ...base,
      shell: job.shell || "sh",
      command: job.command,
      env: stableObject(job.env || {}),
      timeout_ms: Number(job.timeout_ms || 30000)
    };
  }
  if (job.type === "http") {
    return {
      ...base,
      url: job.url,
      method: job.method || "GET",
      headers: stableObject(job.headers || {}),
      body: job.body ?? null,
      accept_status: Array.isArray(job.accept_status) ? [...job.accept_status].sort((a, b) => a - b) : null,
      timeout_ms: Number(job.timeout_ms || 10000)
    };
  }
  return {
    ...base,
    code: job.code,
    timeout_ms: Number(job.timeout_ms || 30000)
  };
}

function fingerprint(job) {
  return createHash("sha256")
    .update(JSON.stringify(stableObject(jobSemanticShape(job))))
    .digest("hex")
    .slice(0, 24);
}

function validatePlanner(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("BLITZ_SMART_PLANNER_INVALID");
  }
  const planner = value;
  const safe = {};
  for (const name of ["openclaw", "hermes"]) {
    const entry = planner[name];
    if (entry == null) continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("BLITZ_SMART_PLANNER_ENTRY_INVALID:" + name);
    }
    const role = String(entry.role || "");
    const accepted = name === "openclaw"
      ? ["PLAN_COMPACTOR", "DEPENDENCY_ROUTER", "RECOVERY_ADVISOR"]
      : ["TASK_SHARDER", "TOOL_SELECTOR", "PREVALIDATOR"];
    if (!accepted.includes(role)) {
      throw new Error("BLITZ_SMART_PLANNER_ROLE_INVALID:" + name);
    }
    safe[name] = {
      role,
      runtime_verified: entry.runtime_verified === true,
      advisory_only: entry.advisory_only !== false,
      trace_id: typeof entry.trace_id === "string" ? entry.trace_id.slice(0, 128) : null
    };
  }
  return safe;
}

function assertSafeJob(job) {
  if (!job || typeof job !== "object" || Array.isArray(job)) throw new Error("BLITZ_SMART_JOB_INVALID");
  if (typeof job.id !== "string" || !JOB_ID_RE.test(job.id)) throw new Error("BLITZ_SMART_JOB_ID_INVALID");
  if (!["command", "http", "inline"].includes(job.type)) throw new Error("BLITZ_SMART_JOB_TYPE_INVALID");
  if (job.type === "command" && (typeof job.command !== "string" || !job.command.trim())) {
    throw new Error("BLITZ_SMART_COMMAND_INVALID:" + job.id);
  }
  if (job.type === "http") {
    if (typeof job.url !== "string" || !/^https?:\/\//i.test(job.url)) {
      throw new Error("BLITZ_SMART_HTTP_URL_INVALID:" + job.id);
    }
  }
  if (job.type === "inline" && (typeof job.code !== "string" || !job.code.trim())) {
    throw new Error("BLITZ_SMART_INLINE_INVALID:" + job.id);
  }
  const encoded = JSON.stringify(job);
  if (/"live_order_enabled"\s*:\s*true/i.test(encoded)) throw new Error("BLITZ_LIVE_ORDER_FORBIDDEN");
}

function normalizeDeps(job) {
  const deps = Array.isArray(job.depends_on) ? job.depends_on : [];
  const unique = [];
  const seen = new Set();
  for (const dep of deps) {
    if (typeof dep !== "string" || !JOB_ID_RE.test(dep)) throw new Error("BLITZ_SMART_DEPENDENCY_ID_INVALID:" + job.id);
    if (dep === job.id) throw new Error("BLITZ_SMART_SELF_DEPENDENCY:" + job.id);
    if (!seen.has(dep)) {
      seen.add(dep);
      unique.push(dep);
    }
  }
  return unique;
}

function assertAcyclic(jobs) {
  const byId = new Map(jobs.map(j => [j.id, j]));
  for (const job of jobs) {
    for (const dep of job.depends_on) {
      if (!byId.has(dep)) throw new Error("BLITZ_SMART_MISSING_DEPENDENCY:" + job.id + ":" + dep);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error("BLITZ_SMART_DEPENDENCY_CYCLE:" + id);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id).depends_on) visit(dep);
    visiting.delete(id);
    visited.add(id);
  }
  for (const job of jobs) visit(job.id);
}

function criticalDepths(jobs) {
  const children = new Map(jobs.map(j => [j.id, []]));
  for (const job of jobs) {
    for (const dep of job.depends_on) children.get(dep).push(job.id);
  }
  const memo = new Map();
  function depth(id) {
    if (memo.has(id)) return memo.get(id);
    const next = children.get(id) || [];
    const value = next.length ? 1 + Math.max(...next.map(depth)) : 0;
    memo.set(id, value);
    return value;
  }
  for (const job of jobs) depth(job.id);
  return memo;
}

export function compileSmartPacket(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("BLITZ_SMART_PACKET_INVALID");
  if (!Array.isArray(input.jobs) || input.jobs.length < 1) throw new Error("BLITZ_SMART_PACKET_EMPTY");
  if (input.jobs.length > 4096) throw new Error("BLITZ_SMART_PACKET_TOO_MANY_JOBS");

  const planner = validatePlanner(input.planner);
  const original = input.jobs.map((job, index) => {
    assertSafeJob(job);
    return {
      ...job,
      depends_on: normalizeDeps(job),
      __input_index: index,
      __fingerprint: fingerprint(job)
    };
  });

  const canonicalByFingerprint = new Map();
  const aliasToCanonical = new Map();
  const canonical = [];

  for (const job of original) {
    const prior = canonicalByFingerprint.get(job.__fingerprint);
    if (!prior) {
      canonicalByFingerprint.set(job.__fingerprint, job.id);
      canonical.push(job);
      continue;
    }
    aliasToCanonical.set(job.id, prior);
  }

  function resolveAlias(id) {
    let current = id;
    const seen = new Set();
    while (aliasToCanonical.has(current)) {
      if (seen.has(current)) throw new Error("BLITZ_SMART_ALIAS_CYCLE:" + current);
      seen.add(current);
      current = aliasToCanonical.get(current);
    }
    return current;
  }

  const jobs = canonical.map(job => {
    const deps = [];
    const seen = new Set();
    for (const dep of job.depends_on) {
      const canonicalDep = resolveAlias(dep);
      if (canonicalDep === job.id) continue;
      if (!seen.has(canonicalDep)) {
        seen.add(canonicalDep);
        deps.push(canonicalDep);
      }
    }
    return { ...job, depends_on: deps };
  });

  assertAcyclic(jobs);
  const depths = criticalDepths(jobs);

  jobs.sort((a, b) => {
    const depthDelta = (depths.get(b.id) || 0) - (depths.get(a.id) || 0);
    if (depthDelta) return depthDelta;
    const explicitDelta = Number(b.priority || 0) - Number(a.priority || 0);
    if (explicitDelta) return explicitDelta;
    return a.__input_index - b.__input_index;
  });

  const executionOrder = jobs.map(j => j.id);
  const priorityById = Object.fromEntries(
    jobs.map(j => [
      j.id,
      {
        critical_depth: depths.get(j.id) || 0,
        explicit_priority: Number(j.priority || 0),
        input_index: j.__input_index
      }
    ])
  );

  const strippedJobs = jobs.map(({ __input_index, __fingerprint, ...job }) => ({
    ...job,
    zeibael_fingerprint: __fingerprint
  }));

  const aliases = Object.fromEntries(aliasToCanonical);
  const runtimeVerifiedAdvisors = Object.values(planner || {}).filter(x => x.runtime_verified).length;

  return {
    packet: {
      ...input,
      smart_mode: "ONE_SHOT_FAST_PATH_V1",
      planner,
      jobs: strippedJobs
    },
    executionOrder,
    priorityById,
    aliases,
    diagnostics: {
      schema: "zeibael.blitz.smart-compile.v1",
      input_jobs: original.length,
      executable_jobs: strippedJobs.length,
      duplicates_removed: original.length - strippedJobs.length,
      planner_advisors_present: Object.keys(planner || {}).length,
      planner_runtime_verified: runtimeVerifiedAdvisors,
      dependency_graph_validated: true,
      critical_path_scheduling: true,
      live_order_enabled: false
    }
  };
}
