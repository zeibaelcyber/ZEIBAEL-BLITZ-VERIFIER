import { createHash } from "node:crypto";

const JOB_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => [key, stableObject(val)])
  );
}

function hashStable(value, length = 64) {
  return createHash("sha256")
    .update(JSON.stringify(stableObject(value)))
    .digest("hex")
    .slice(0, length);
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

function dedupeEligible(job) {
  if (job.dedupe_safe === true) return true;
  if (job.dedupe_safe === false) return false;
  if (job.type === "inline") return true;
  if (job.type === "http") {
    const method = String(job.method || "GET").toUpperCase();
    return (method === "GET" || method === "HEAD") && job.body == null;
  }
  return false;
}

function fingerprint(job) {
  return hashStable(jobSemanticShape(job), 24);
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
    if (entry.advisory_only === false) {
      throw new Error("BLITZ_SMART_PLANNER_EXECUTION_AUTHORITY_FORBIDDEN:" + name);
    }
    safe[name] = {
      role,
      runtime_verified: entry.runtime_verified === true,
      advisory_only: true,
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


function transitiveReduce(jobs) {
  const byId = new Map(jobs.map(j => [j.id, j]));
  const reachMemo = new Map();

  function ancestors(id) {
    if (reachMemo.has(id)) return reachMemo.get(id);
    const out = new Set();
    for (const dep of byId.get(id)?.depends_on || []) {
      out.add(dep);
      for (const ancestor of ancestors(dep)) out.add(ancestor);
    }
    reachMemo.set(id, out);
    return out;
  }

  let removed = 0;
  const removedByJob = {};
  const reduced = jobs.map(job => {
    if (job.depends_on.length < 2) return job;
    const redundant = new Set();
    for (const dep of job.depends_on) {
      for (const other of job.depends_on) {
        if (other === dep) continue;
        if (ancestors(other).has(dep)) {
          redundant.add(dep);
          break;
        }
      }
    }
    if (!redundant.size) return job;
    const dropped = job.depends_on.filter(dep => redundant.has(dep));
    removed += dropped.length;
    removedByJob[job.id] = dropped;
    return { ...job, depends_on: job.depends_on.filter(dep => !redundant.has(dep)) };
  });

  return { jobs: reduced, removed, removedByJob };
}

function dependencyLayerMetrics(jobs) {
  const byId = new Map(jobs.map(j => [j.id, j]));
  const memo = new Map();
  function level(id) {
    if (memo.has(id)) return memo.get(id);
    const deps = byId.get(id)?.depends_on || [];
    const value = deps.length ? 1 + Math.max(...deps.map(level)) : 0;
    memo.set(id, value);
    return value;
  }
  const widths = {};
  for (const job of jobs) {
    const l = level(job.id);
    widths[l] = (widths[l] || 0) + 1;
  }
  return {
    initial_ready_width: widths[0] || 0,
    max_parallelizable_layer_width: Math.max(0, ...Object.values(widths)),
    layer_widths: widths
  };
}

function prevalidationMetrics(jobs, depths) {
  const typeCounts = { command: 0, http: 0, inline: 0 };
  let externalHttpJobs = 0;
  let mutatingHttpJobs = 0;
  let dedupeEligibleJobs = 0;
  for (const job of jobs) {
    typeCounts[job.type] = (typeCounts[job.type] || 0) + 1;
    if (job.type === "http") {
      externalHttpJobs++;
      const method = String(job.method || "GET").toUpperCase();
      if (!SAFE_HTTP_METHODS.has(method)) mutatingHttpJobs++;
    }
    if (dedupeEligible(job)) dedupeEligibleJobs++;
  }
  const layers = dependencyLayerMetrics(jobs);
  return {
    job_type_counts: typeCounts,
    external_http_jobs: externalHttpJobs,
    mutating_http_jobs: mutatingHttpJobs,
    dedupe_eligible_jobs: dedupeEligibleJobs,
    max_critical_depth: Math.max(0, ...depths.values()),
    ...layers
  };
}

export function compileSmartPacket(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("BLITZ_SMART_PACKET_INVALID");
  if (!Array.isArray(input.jobs) || input.jobs.length < 1) throw new Error("BLITZ_SMART_PACKET_EMPTY");
  if (input.jobs.length > 4096) throw new Error("BLITZ_SMART_PACKET_TOO_MANY_JOBS");
  if (/"live_order_enabled"\s*:\s*true/i.test(JSON.stringify(input))) {
    throw new Error("BLITZ_LIVE_ORDER_FORBIDDEN");
  }

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
    if (!dedupeEligible(job)) {
      canonical.push(job);
      continue;
    }
    const prior = canonicalByFingerprint.get(job.__fingerprint);
    if (!prior) {
      canonicalByFingerprint.set(job.__fingerprint, job.id);
      canonical.push(job);
      continue;
    }
    aliasToCanonical.set(job.id, prior);
    const target = canonical.find(item => item.id === prior);
    if (target) {
      target.depends_on = [...new Set([...target.depends_on, ...job.depends_on])];
    }
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

  let jobs = canonical.map(job => {
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
  const reduction = transitiveReduce(jobs);
  jobs = reduction.jobs;
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
  const plannerEntries = Object.values(planner || {});
  const runtimeVerifiedAdvisors = plannerEntries.filter(x => x.runtime_verified).length;
  const unverifiedAdvisorsBypassed = plannerEntries.filter(x => !x.runtime_verified).length;
  const prevalidation = prevalidationMetrics(jobs, depths);
  const advisorKernel = {
    schema: "zeibael.blitz.internal-advisor-kernel.v1",
    mode: "DETERMINISTIC_LOCAL",
    external_roundtrips: 0,
    external_runtime_promoted: false,
    final_packet_immutable: true,
    plan_compaction: {
      equivalent_role: "PLAN_COMPACTION",
      duplicate_jobs_removed: original.length - strippedJobs.length,
      redundant_dependency_edges_removed: reduction.removed,
      redundant_dependency_edges_by_job: reduction.removedByJob
    },
    prevalidation: {
      equivalent_role: "PREVALIDATION",
      ...prevalidation
    },
    external_advisors: {
      present: plannerEntries.length,
      runtime_verified: runtimeVerifiedAdvisors,
      unverified_bypassed: unverifiedAdvisorsBypassed
    }
  };

  const packetWithoutFingerprint = {
    ...input,
    smart_mode: "ONE_SHOT_FAST_PATH_V1",
    planner,
    advisor_kernel: advisorKernel,
    jobs: strippedJobs
  };
  const packetFingerprint = hashStable(packetWithoutFingerprint, 64);

  return {
    packet: {
      ...packetWithoutFingerprint,
      packet_fingerprint: packetFingerprint
    },
    executionOrder,
    priorityById,
    aliases,
    diagnostics: {
      schema: "zeibael.blitz.smart-compile.v1",
      input_jobs: original.length,
      executable_jobs: strippedJobs.length,
      duplicates_removed: original.length - strippedJobs.length,
      transitive_dependency_edges_removed: reduction.removed,
      dedupe_policy: "PURE_OR_EXPLICIT_ONLY",
      planner_advisors_present: plannerEntries.length,
      planner_runtime_verified: runtimeVerifiedAdvisors,
      planner_unverified_bypassed: unverifiedAdvisorsBypassed,
      dependency_graph_validated: true,
      critical_path_scheduling: true,
      packet_fingerprint: packetFingerprint,
      advisor_kernel: advisorKernel,
      live_order_enabled: false
    }
  };
}
