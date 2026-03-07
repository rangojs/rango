import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { postprocessBundle } from "../discovery/bundle-postprocess.js";
import type { DiscoveryState } from "../discovery/state.js";

function createMinimalState(
  projectRoot: string,
  overrides: Partial<DiscoveryState> = {},
): DiscoveryState {
  return {
    resolvedEntryPath: undefined,
    projectRoot,
    isBuildMode: true,
    userResolveAlias: undefined,
    scanFilter: undefined,
    cachedRouterFiles: undefined,
    opts: { enableBuildPrerender: true },
    mergedRouteManifest: null,
    perRouterManifests: [],
    mergedPrecomputedEntries: null,
    mergedRouteTrie: null,
    perRouterTrieMap: new Map(),
    perRouterPrecomputedMap: new Map(),
    perRouterManifestDataMap: new Map(),
    prerenderCollectedData: null,
    staticCollectedData: null,
    handlerChunkInfo: null,
    staticHandlerChunkInfo: null,
    rscEntryFileName: "index.js",
    resolvedPrerenderModules: undefined,
    resolvedStaticModules: undefined,
    discoveryDone: null,
    devServerOrigin: null,
    devServer: null,
    selfWrittenGenFiles: new Map(),
    SELF_WRITE_WINDOW_MS: 5_000,
    ...overrides,
  };
}

describe("postprocessBundle - static asset hashing", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bundle-postprocess-"));
    const rscDir = join(tmpDir, "dist", "rsc");
    mkdirSync(rscDir, { recursive: true });
    writeFileSync(join(rscDir, "index.js"), "// rsc entry\n");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("produces distinct assets for same encoded but different handles", () => {
    const sharedPayload = "0:D{}\n";
    const state = createMinimalState(tmpDir, {
      staticCollectedData: {
        "handler-a": {
          encoded: sharedPayload,
          handles: { "route.index": [{ title: "Home" }] },
        },
        "handler-b": {
          encoded: sharedPayload,
          handles: { "route.index": [{ title: "About" }] },
        },
      },
    });

    postprocessBundle(state);

    const assetsDir = join(tmpDir, "dist", "rsc", "assets");
    const assets = readdirSync(assetsDir).filter((f) => f.startsWith("__st-"));
    expect(assets.length).toBe(2);
    expect(assets[0]).not.toBe(assets[1]);
  });

  it("reuses asset when encoded and handles are identical", () => {
    const state = createMinimalState(tmpDir, {
      staticCollectedData: {
        "handler-a": {
          encoded: "0:D{}\n",
          handles: { "route.index": [{ title: "Same" }] },
        },
        "handler-b": {
          encoded: "0:D{}\n",
          handles: { "route.index": [{ title: "Same" }] },
        },
      },
    });

    postprocessBundle(state);

    const assetsDir = join(tmpDir, "dist", "rsc", "assets");
    const assets = readdirSync(assetsDir).filter((f) => f.startsWith("__st-"));
    // Same payload produces the same hash, so only one asset file
    expect(assets.length).toBe(1);
  });

  it("produces distinct assets when only handles differ (no-handles vs handles)", () => {
    const state = createMinimalState(tmpDir, {
      staticCollectedData: {
        "handler-a": {
          encoded: "0:D{}\n",
          handles: {},
        },
        "handler-b": {
          encoded: "0:D{}\n",
          handles: { "route.index": [{ nav: true }] },
        },
      },
    });

    postprocessBundle(state);

    const assetsDir = join(tmpDir, "dist", "rsc", "assets");
    const assets = readdirSync(assetsDir).filter((f) => f.startsWith("__st-"));
    expect(assets.length).toBe(2);
  });
});
