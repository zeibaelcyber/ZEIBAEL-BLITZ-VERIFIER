import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

const evidencePath = "evidence/warm-runner-real-webcontainer.json";
const child = spawn(process.execPath, ["services/warm-runner/selftest.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ZEIBAEL_LIVE_ORDER_ENABLED: "false",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
  if (stdout.length > 200000) stdout = stdout.slice(-200000);
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
  if (stderr.length > 20000) stderr = stderr.slice(-20000);
});

const exitCode = await new Promise((resolve) => child.once("close", resolve));
const marker = stdout
  .split(/\r?\n/)
  .find((line) => line.startsWith("BLITZ_WARM_RUNNER_SELFTEST="));

let warmRunner = null;
let parseError = null;
if (marker) {
  try {
    warmRunner = JSON.parse(marker.slice("BLITZ_WARM_RUNNER_SELFTEST=".length));
  } catch (error) {
    parseError = String(error?.stack || error);
  }
}

const evidence = {
  schema: "zeibael.blitz.webcontainer-warm-runner-canary.v2",
  ok:
    exitCode === 0 &&
    warmRunner?.ok === true &&
    warmRunner?.live_order_enabled === false,
  runtime: "STACKBLITZ_WEBCONTAINER",
  host: "STACKBLITZ_GITHUB_PROJECT",
  node: {
    version: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  warm_runner: warmRunner,
  selftest_exit_code: exitCode,
  marker_found: Boolean(marker),
  parse_error: parseError,
  stderr: stderr.slice(-6000),
  canonical_state: "SUPABASE",
  live_order_enabled: false,
};

await mkdir("evidence", { recursive: true });
await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
console.log("ZEIBAEL_STACKBLITZ_HOSTED_WARM_RUNNER=" + JSON.stringify({
  ok: evidence.ok,
  schema: evidence.schema,
  runtime: evidence.runtime,
  node: evidence.node,
  warm_runner_schema: warmRunner?.schema || null,
  cache_hits: warmRunner?.second?.cache?.hits ?? null,
  pid_reused: warmRunner?.pid_reused ?? null,
  broker_status: warmRunner?.broker?.status ?? null,
  live_order_enabled: false,
}));
if (!evidence.ok) process.exitCode = 1;
