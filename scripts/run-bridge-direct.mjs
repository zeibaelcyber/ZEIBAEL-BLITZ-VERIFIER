import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const packetPath = "examples/direct-bridge-task.packet.json";
const packet = JSON.parse(await readFile(packetPath, "utf8"));
if (!packet || typeof packet.task_id !== "string") {
  console.error("invalid_packet");
  process.exit(2);
}

const child = spawn(process.execPath, ["src/acker-accelerator.mjs", packetPath], {
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => { stdout += d; });
child.stderr.on("data", (d) => { stderr += d; });

const code = await new Promise((resolve) => child.on("close", resolve));

let evidence;
try {
  evidence = JSON.parse(stdout);
} catch {
  console.error(stderr || stdout || "invalid_evidence");
  process.exit(2);
}

const verified =
  code === 0 &&
  evidence.failed === 0 &&
  evidence.blocked === 0 &&
  evidence.pass === evidence.jobs_total;

const safeTaskId = String(evidence.task_id || "unknown")
  .replace(/[^A-Za-z0-9._-]/g, "-")
  .slice(0, 64);

console.log(
  `ZBR1:${verified ? "VERIFIED" : "FAILED"}:${evidence.pass}:${evidence.failed}:${evidence.blocked}:${safeTaskId}`,
);

if (!verified) {
  console.log(stdout);
  if (stderr) console.error(stderr);
  process.exitCode = 1;
}
