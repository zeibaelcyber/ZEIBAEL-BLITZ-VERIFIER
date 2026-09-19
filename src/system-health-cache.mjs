import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const DEFAULT_SYSTEM_HEALTH_CACHE_TTL_MS = 5000;

function cacheFile(dir) {
  const root = resolve(dir || process.env.ZEIBAEL_BLITZ_CACHE_DIR || ".zeibael-blitz-cache");
  return { root, file: resolve(root, "system-health-v1.json"), temp: resolve(root, `system-health-v1.${process.pid}.tmp`) };
}

export function isSafeSystemHealthPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.ok !== true || payload.service !== "ZEIBAEL_BLITZ_HEALTH") return false;
  if (payload.secrets_exposed !== false || payload.live_order_enabled !== false) return false;
  const checks = Array.isArray(payload.checks) ? payload.checks : [];
  if (!checks.length) return false;
  return !checks.some(item => item?.required !== false && item?.ok !== true);
}

export async function readSystemHealthCache(url, options = {}) {
  const ttlMs = Math.max(1, Number(options.ttlMs || DEFAULT_SYSTEM_HEALTH_CACHE_TTL_MS));
  const { file } = cacheFile(options.dir);
  try {
    const row = JSON.parse(await readFile(file, "utf8"));
    const storedAt = Number(row?.stored_at);
    const ageMs = Date.now() - storedAt;
    if (row?.schema !== "zeibael.system-health-cache.v1" || row?.url !== url) return null;
    if (!Number.isFinite(storedAt) || ageMs < 0 || ageMs > ttlMs) return null;
    if (!isSafeSystemHealthPayload(row.payload)) return null;
    return { payload: row.payload, age_ms: ageMs, stored_at: storedAt };
  } catch { return null; }
}

export async function writeSystemHealthCache(url, payload, options = {}) {
  if (!isSafeSystemHealthPayload(payload)) return false;
  const { root, file, temp } = cacheFile(options.dir);
  await mkdir(root, { recursive: true });
  const row = { schema: "zeibael.system-health-cache.v1", url, stored_at: Date.now(), payload };
  await writeFile(temp, JSON.stringify(row), "utf8");
  await rename(temp, file);
  return true;
}
