/**
 * PPR shell HIT serve cost (rsc-rendering.ts shellServePlan, serveShellHit):
 * a runtime shell HIT read from the cache store, and a build shell HIT read
 * from the build manifest (shell-build-manifest.ts) after the store misses,
 * each through serveShellRequest, the router's production request handler.
 * The build manifest is installed as the built worker reads it
 * (globalThis.__loadShellManifestModule), holding the entry a runtime
 * capture stored.
 *
 * Runs in the rsc project (react-server condition, production React):
 *
 *   ./node_modules/.bin/vitest bench --run --config vitest.rsc.config.ts src/rsc/__tests__/shell-serve.bench.tsx
 *
 * To compare two revisions, run it in both checkouts alternately, several
 * times each, on a quiet machine.
 */
import { afterAll, bench, describe, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../../testing/vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../../testing/vitest-stubs/plugin-rsc.js"),
);

import {
  resetShellTestState,
  serveShellRequest,
} from "../../testing/flight.entry.js";
import {
  createLoader,
  createRouter,
  Prerender,
  urls,
  type BuildContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { buildShellManifestKey } from "../../prerender/shell-manifest-key.js";

let sink: unknown;

const StockLoader = createLoader(async () => ({ stock: 3 }));

const router = createRouter({}).routes(
  urls(({ layout, path, loader }) => [
    layout(
      () => <main>shell</main>,
      () => [
        path(
          "/item/:id",
          (ctx) => <h1>{`item ${ctx.params.id}`}</h1>,
          { name: "item", ppr: { ttl: 3600 } },
          () => [loader(StockLoader)],
        ),
        path(
          "/pre/:id",
          Prerender<{ id: string }>(
            async () => [{ id: "1" }],
            (ctx: BuildContext<{ id: string }>) => (
              <h1>{`pre ${ctx.params.id}`}</h1>
            ),
          ),
          { name: "pre", ppr: { ttl: 3600 } },
          () => [loader(StockLoader)],
        ),
      ],
    ),
  ]),
);

type Source = "runtime shell" | "build shell";

const PATHS: Record<Source, string> = {
  "runtime shell": "/item/1",
  "build shell": "/pre/1",
};

const stores = new Map<Source, MemorySegmentCacheStore>();
const previousManifest = globalThis.__loadShellManifestModule;

afterAll(() => {
  globalThis.__loadShellManifestModule = previousManifest;
});

/**
 * Capture each path's shell with a MISS. The runtime source serves from the
 * store that holds it; the build source serves from the manifest, over a
 * store that never holds the shell (its ttl keeps it fresh: no recapture).
 */
async function prime(): Promise<void> {
  globalThis.__loadShellManifestModule = undefined;
  await resetShellTestState();
  const runtime = new MemorySegmentCacheStore();
  await serveShellRequest(router, PATHS["runtime shell"], {
    cacheStore: runtime,
  });
  stores.set("runtime shell", runtime);

  const captured = await serveShellRequest(router, PATHS["build shell"], {
    cacheStore: new MemorySegmentCacheStore(),
  });
  const entry = await captured.readEntry();
  if (!entry) throw new Error("build shell: the capture stored nothing");
  const manifestKey = buildShellManifestKey(router.id, PATHS["build shell"]);
  globalThis.__loadShellManifestModule = async () => ({
    default: { [manifestKey]: manifestKey },
    loadShellAsset: async () => ({ default: { entry, ttl: 3600 } }),
  });
  stores.set("build shell", new MemorySegmentCacheStore());

  for (const source of ["runtime shell", "build shell"] as const) {
    const result = await serve(source);
    const stored = await result.readEntry();
    if ((source === "build shell") !== (stored === null)) {
      throw new Error(`${source}: served from the wrong source`);
    }
  }
}

async function serve(source: Source) {
  const result = await serveShellRequest(router, PATHS[source], {
    cacheStore: stores.get(source)!,
  });
  if (result.shellStatus !== "HIT") {
    throw new Error(`${source}: ${result.shellStatus ?? "no shell status"}`);
  }
  sink = result.body;
  return result;
}

describe("shell HIT through serveShellRequest", () => {
  for (const source of ["runtime shell", "build shell"] as const) {
    bench(
      `${source} HIT, document`,
      async () => {
        await serve(source);
      },
      {
        time: 3000,
        setup: prime,
      },
    );
  }
});

void sink;
