import { mkdir, readFile, writeFile } from "node:fs/promises";

const evidence = JSON.parse(await readFile("evidence/browser-fabric-real-host.json", "utf8"));
if (evidence?.ok !== true) throw new Error("CANARY_NOT_PASS");
const sha = String(process.env.GITHUB_SHA || "");
const runId = Number(process.env.GITHUB_RUN_ID || 0);
const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT || 0);
if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("INVALID_GITHUB_SHA");
if (!Number.isInteger(runId) || runId < 1) throw new Error("INVALID_GITHUB_RUN_ID");
if (!Number.isInteger(runAttempt) || runAttempt < 1) throw new Error("INVALID_GITHUB_RUN_ATTEMPT");

const body = {
  schema: "zeibael.blitz.runtime-sentinel.v1",
  sentinel_type: "BROWSER_FABRIC_REAL_HOST",
  capability_key: "stackblitz_webcontainer_compute_v1",
  source_commit: sha,
  run_id: runId,
  run_attempt: runAttempt,
  evidence,
};
await mkdir("evidence", { recursive: true });
await writeFile("evidence/browser-fabric-sentinel-request.json", JSON.stringify(body, null, 2) + "\n", "utf8");
console.log(JSON.stringify({
  schema: body.schema,
  sentinel_type: body.sentinel_type,
  capability_key: body.capability_key,
  source_commit: body.source_commit,
  run_id: body.run_id,
  run_attempt: body.run_attempt,
  evidence_ok: body.evidence.ok,
  live_order_enabled: body.evidence.live_order_enabled,
}));
