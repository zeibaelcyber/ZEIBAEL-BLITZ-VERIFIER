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
  let generation = 0;
  let persistedGeneration = 0;
  let flushPromise = null;

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
    let changed = false;
    for (const [key, item] of entries) {
      if (!Number.isFinite(item.expires_at) || item.expires_at <= now) {
        entries.delete(key);
        changed = true;
      }
    }
    if (entries.size > maxEntries) {
      const ordered = [...entries.values()].sort((a, b) => Number(a.stored_at || 0) - Number(b.stored_at || 0));
      for (const item of ordered.slice(0, entries.size - maxEntries)) {
        entries.delete(item.key);
        changed = true;
      }
    }
    if (changed) generation++;
    return changed;
  }

  return {
    dir,
    get(key) {
      const item = entries.get(key);
      if (!item) return null;
      if (!Number.isFinite(item.expires_at) || item.expires_at <= nowMs()) {
        entries.delete(key);
        generation++;
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
      generation++;
      prune();
    },
    async flush() {
      prune();
      if (persistedGeneration >= generation) return;
      if (flushPromise) {
        await flushPromise;
        if (persistedGeneration < generation) return this.flush();
        return;
      }
      const targetGeneration = generation;
      const payload = {
        schema: 'zeibael.blitz.cache.v1',
        written_at: new Date().toISOString(),
        generation: targetGeneration,
        entries: [...entries.values()]
      };
      flushPromise = (async () => {
        await writeFile(temp, JSON.stringify(payload), 'utf8');
        await rename(temp, file);
        persistedGeneration = Math.max(persistedGeneration, targetGeneration);
      })().finally(() => { flushPromise = null; });
      await flushPromise;
      if (persistedGeneration < generation) return this.flush();
    },
    size() { return entries.size; }
  };
}
