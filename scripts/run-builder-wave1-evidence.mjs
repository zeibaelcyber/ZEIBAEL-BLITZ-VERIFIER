import { spawn } from "node:child_process";

const child = spawn(process.execPath, [
  "src/acker-accelerator.mjs",
  "examples/builder-wave1-evidence.packet.json"
], { stdio: ["ignore","pipe","pipe"] });

let stdout = "";
let stderr = "";
child.stdout.on("data", d => { stdout += d; });
child.stderr.on("data", d => { stderr += d; });

child.on("close", code => {
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch {}
  const final = parsed?.results?.find(x => x?.id === "wave1_final")?.value ?? null;
  const verified = code === 0 &&
    parsed?.failed === 0 &&
    parsed?.blocked === 0 &&
    parsed?.pass === parsed?.jobs_total &&
    final?.status === "VERIFIED";

  const result = {
    schema: "zeibael.builder_plugins.wave1.stackblitz_result.v1",
    status: verified ? "VERIFIED" : "FAILED",
    runtime: "STACKBLITZ_WEBCONTAINER",
    jobs_total: parsed?.jobs_total ?? null,
    pass: parsed?.pass ?? null,
    failed: parsed?.failed ?? null,
    blocked: parsed?.blocked ?? null,
    duration_ms: parsed?.duration_ms ?? null,
    final,
    stderr: stderr ? stderr.slice(-1000) : ""
  };
  console.log("ZEIBAEL_BUILDER_WAVE1_RESULT=" + JSON.stringify(result));
  if (!verified) process.exitCode = 1;
});
