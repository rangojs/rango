import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { VercelRuntimeCache } from "@rangojs/router/cache";

// A Vercel Runtime Cache handle backed by a directory, so VercelCacheStore
// keeps its entries across a server restart and a rebuild: the persistence a
// deployed store has and MemorySegmentCacheStore does not. The directory comes
// from the environment because it has to outlive the build output.
const dir = process.env.RANGO_E2E_CACHE_DIR ?? ".cache-version-store";

interface Stored {
  key: string;
  value: unknown;
  expiresAt: number | null;
  tags: string[];
}

function fileFor(key: string): string {
  return join(dir, `${createHash("sha256").update(key).digest("hex")}.json`);
}

function read(path: string): Stored | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Stored;
  } catch {
    return undefined;
  }
}

export const fileCache: VercelRuntimeCache = {
  async get(key) {
    const path = fileFor(key);
    const stored = read(path);
    if (!stored) return undefined;
    if (stored.expiresAt !== null && stored.expiresAt <= Date.now()) {
      rmSync(path, { force: true });
      return undefined;
    }
    return stored.value;
  },
  async set(key, value, options) {
    mkdirSync(dir, { recursive: true });
    const stored: Stored = {
      key,
      value,
      expiresAt: options?.ttl ? Date.now() + options.ttl * 1000 : null,
      tags: options?.tags ?? [],
    };
    writeFileSync(fileFor(key), JSON.stringify(stored));
  },
  async delete(key) {
    rmSync(fileFor(key), { force: true });
  },
  async expireTag(tag) {
    if (!existsSync(dir)) return;
    const tags = new Set(Array.isArray(tag) ? tag : [tag]);
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (read(path)?.tags.some((entry) => tags.has(entry))) {
        rmSync(path, { force: true });
      }
    }
  },
};
