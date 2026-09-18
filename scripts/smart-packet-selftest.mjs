import assert from "node:assert/strict";
import { compileSmartPacket } from "../src/smart-packet.mjs";

const compiled = compileSmartPacket({
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
});

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
