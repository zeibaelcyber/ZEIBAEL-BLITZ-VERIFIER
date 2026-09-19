import assert from "node:assert/strict";
import { compileSmartPacket } from "../src/smart-packet.mjs";

const baseInput = {
  task_id: "smart-fast-path-selftest",
  objective: "prove one-shot planner compile",
  max_concurrency: 32,
  planner: {
    openclaw: { role: "PLAN_COMPACTOR", runtime_verified: false, advisory_only: true, trace_id: "oc-test" },
    hermes: { role: "TASK_SHARDER", runtime_verified: false, advisory_only: true, trace_id: "h-test" }
  },
  jobs: [
    { id: "fetch_a", type: "inline", code: "return 21*2" },
    { id: "fetch_a_duplicate", type: "inline", code: "return 21*2" },
    { id: "fetch_b", type: "inline", code: "return 40+2" },
    { id: "join", type: "inline", depends_on: ["fetch_a_duplicate", "fetch_b"], code: "return {ok:true}" }
  ]
};

const compiled = compileSmartPacket(baseInput);
assert.equal(compiled.diagnostics.input_jobs, 4);
assert.equal(compiled.diagnostics.executable_jobs, 3);
assert.equal(compiled.diagnostics.duplicates_removed, 1);
assert.equal(compiled.aliases.fetch_a_duplicate, "fetch_a");
const join = compiled.packet.jobs.find(j => j.id === "join");
assert.deepEqual(join.depends_on.sort(), ["fetch_a", "fetch_b"]);
assert.equal(compiled.packet.smart_mode, "ONE_SHOT_FAST_PATH_V1");
assert.equal(compiled.priorityById.fetch_a.critical_depth, 1);
assert.equal(compiled.priorityById.fetch_b.critical_depth, 1);
assert.equal(compiled.priorityById.join.critical_depth, 0);
assert.equal(compiled.packet.advisor_kernel.mode, "DETERMINISTIC_LOCAL");
assert.equal(compiled.packet.advisor_kernel.external_roundtrips, 0);
assert.equal(compiled.packet.advisor_kernel.external_runtime_promoted, false);
assert.equal(compiled.packet.advisor_kernel.external_advisors.unverified_bypassed, 2);
assert.equal(compiled.diagnostics.planner_runtime_verified, 0);
assert.equal(compiled.diagnostics.planner_unverified_bypassed, 2);
assert.match(compiled.packet.packet_fingerprint, /^[a-f0-9]{64}$/);

const compiledAgain = compileSmartPacket(baseInput);
assert.equal(compiledAgain.packet.packet_fingerprint, compiled.packet.packet_fingerprint);

const transitive = compileSmartPacket({
  task_id: "transitive-reduction",
  jobs: [
    { id: "root", type: "inline", code: "return 1" },
    { id: "middle", type: "inline", depends_on: ["root"], code: "return 2" },
    { id: "leaf", type: "inline", depends_on: ["root", "middle"], code: "return 3" }
  ]
});
const leaf = transitive.packet.jobs.find(j => j.id === "leaf");
assert.deepEqual(leaf.depends_on, ["middle"]);
assert.equal(transitive.diagnostics.transitive_dependency_edges_removed, 1);
assert.deepEqual(transitive.packet.advisor_kernel.plan_compaction.redundant_dependency_edges_by_job.leaf, ["root"]);
assert.equal(transitive.packet.advisor_kernel.prevalidation.initial_ready_width, 1);
assert.equal(transitive.packet.advisor_kernel.prevalidation.max_parallelizable_layer_width, 1);
assert.equal(transitive.packet.advisor_kernel.prevalidation.max_critical_depth, 2);

const risk = compileSmartPacket({
  task_id: "prevalidation-risk-metrics",
  jobs: [
    { id: "read", type: "http", url: "https://example.com", method: "GET" },
    { id: "write", type: "http", url: "https://example.com/x", method: "POST", body: "{}" },
    { id: "cmd", type: "command", command: "echo ok" },
    { id: "inline", type: "inline", code: "return true" }
  ]
});
assert.equal(risk.packet.advisor_kernel.prevalidation.external_http_jobs, 2);
assert.equal(risk.packet.advisor_kernel.prevalidation.mutating_http_jobs, 1);
assert.equal(risk.packet.advisor_kernel.prevalidation.job_type_counts.command, 1);
assert.equal(risk.packet.advisor_kernel.prevalidation.job_type_counts.inline, 1);

const sideEffects = compileSmartPacket({
  task_id: "side-effects",
  jobs: [
    { id: "cmd_a", type: "command", command: "echo same" },
    { id: "cmd_b", type: "command", command: "echo same" }
  ]
});
assert.equal(sideEffects.diagnostics.executable_jobs, 2);
assert.equal(sideEffects.diagnostics.duplicates_removed, 0);

assert.throws(() => compileSmartPacket({
  task_id: "planner-authority-forbidden",
  planner: { openclaw: { role: "PLAN_COMPACTOR", runtime_verified: false, advisory_only: false } },
  jobs: [{ id: "a", type: "inline", code: "return 1" }]
}), /BLITZ_SMART_PLANNER_EXECUTION_AUTHORITY_FORBIDDEN:openclaw/);

assert.throws(() => compileSmartPacket({
  task_id: "live-order",
  live_order_enabled: true,
  jobs: [{ id: "a", type: "inline", code: "return 1" }]
}), /BLITZ_LIVE_ORDER_FORBIDDEN/);

assert.throws(() => compileSmartPacket({
  task_id: "cycle",
  jobs: [
    { id: "a", type: "inline", depends_on: ["b"], code: "return 1" },
    { id: "b", type: "inline", depends_on: ["a"], code: "return 2" }
  ]
}), /BLITZ_SMART_DEPENDENCY_CYCLE/);

assert.throws(() => compileSmartPacket({
  task_id: "missing",
  jobs: [{ id: "a", type: "inline", depends_on: ["missing"], code: "return 1" }]
}), /BLITZ_SMART_MISSING_DEPENDENCY/);

console.log("BLITZ_SMART_PACKET_SELFTEST_PASS");
