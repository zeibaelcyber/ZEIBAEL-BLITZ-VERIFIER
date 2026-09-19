import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULT_MAX_ENTRIES = 4096;

function nowMs() { return Date.now(); }

export async function openBlitzResultCache(options = {}) {
  const dir = resolve(options.dir || process.env.ZEIBAEL_BLITZ_CACHE_DIR || '.zeibael-blitz-cache');
  const file = resolve(dir, 'results-v1.json');
  const temp = resolve(dir, `results-v1.${process.pid}.tmp`);
  const configuredMax = Number(options.maxEntries || process.env.ZEIBAEL_BLITZ_CACHE_MAX_ENTRIES || DEFAULT_MAX_ENTRIES);
  const maxEntries = Math.max(16, Math.min(65536, Number.isFinite(configuredMax) ? Math.floor(configuredMax) : DEFAULT_MAX_ENTRIES));
  const entries = new Map();
  let dirty = false;

  await mkdir(dir, { recursive: true });
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (parsed?.schema === 'zeibael.blitz.cache.v1' && Array.isArray(parsed.entries)) {
      for (const item of parsed.entries) {
        if (!item || typeof item.key !== 'string') continue;
        if (!Number.isFinite(item.expires_at) || item.expires_at <= nowMs()) continue;
        entries.set(item.key, item);
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // Corrupt cache is a miss, never an execution blocker.
    }
  }

  function prune() {
    const now = nowMs();
    for (const [key, item] of entries) {
      if (!Number.isFinite(item.expires_at) || item.expires_at <= now) entries.delete(key);
    }
    if (entries.size <= maxEntries) return;
    const ordered = [...entries.values()].sort((a, b) => Number(a.stored_at || 0) - Number(b.stored_at || 0));
    for (const item of ordered.slice(0, entries.size - maxEntries)) entries.delete(item.key);
  }

  return {
    dir,
    get(key) {
      const item = entries.get(key);
      if (!item) return null;
      if (!Number.isFinite(item.expires_at) || item.expires_at <= nowMs()) {
        entries.delete(key);
        dirty = true;
        return null;
      }
      return item;
    },
    set(key, result, ttlMs) {
      const ttl = Math.max(1, Number(ttlMs || 0));
      const storedAt = nowMs();
      entries.set(key, {
        key,
        stored_at: storedAt,
        expires_at: storedAt + ttl,
        result
      });
      dirty = true;
      prune();
    },
    async flush() {
      prune();
      if (!dirty) return;
      const payload = {
        schema: 'zeibael.blitz.cache.v1',
        written_at: new Date().toISOString(),
        entries: [...entries.values()]
      };
      await writeFile(temp, JSON.stringify(payload), 'utf8');
      await rename(temp, file);
      dirty = false;
    },
    size() { return entries.size; }
  };
}
