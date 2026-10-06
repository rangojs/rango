import { test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import {
  expectDevWarmOfLocalMemoryStoreRuns,
  expectWarmOfLocalStoreIsRefused,
  expectMixedBatchWarmsOnTheRequestOrigin,
  expectOnlyIfStaleWarmLeavesFreshShellAlone,
  expectWarmMakesNextDocumentAShellHit,
  expectWarmOfCookieReaderStoresNothing,
  expectWarmReplacesCachedRecord,
  expectWarmReplacesStoredShell,
  type PrerenderWarmFixture,
} from "@shared/e2e";

// router.prerender() for every route (issue #1062): a route that is not
// Prerender(..., { onDemand }) is warmed through the request handler, in a
// real browser. The fixture is test-app/src/urls/prerender-warm.tsx; the
// bodies are shared with tests/cloudflare-basic/e2e/prerender-warm.test.ts.
// The dispatch table, every refusal and the per-layer forced miss are pinned
// by src/prerender/__tests__/create-prerender-trigger.test.ts and, through
// serveShellRequest, src/testing/__tests__/prerender-warm.rsc-test.tsx.
//
// This app's cache store is a memory store: its router.tsx declares it shared
// (one process serves the app), which is what lets the production describe
// warm at all. The shipped MemorySegmentCacheStore is refused in production
// (src/cache/__tests__/store-scope.test.ts and the userland test above).
//
// Own isolatedServer, like the other shell suites: captures are background
// tasks of this suite's requests only. Each test owns its ?probe=.

function runPrerenderWarmSpec(f: Fixture) {
  const fixture = (): PrerenderWarmFixture => ({
    shellUrl: f.url("/warm/shell"),
    cachedUrl: f.url("/warm/cached"),
    personalUrl: f.url("/warm/personal"),
    triggerUrl: f.url("/warm/__trigger"),
    bumpUrl: f.url("/warm/__bump"),
    onDemandPath: (slug) => `/on-demand/${slug}`,
  });

  test("warming a ppr route makes the next document request a shell HIT that hydrates clean", async ({
    page,
  }) => {
    await expectWarmMakesNextDocumentAShellHit(page, fixture());
  });

  test("a warm replaces a stored shell: the next document shows the newer render", async ({
    page,
  }) => {
    await expectWarmReplacesStoredShell(page, fixture());
  });

  test("a warm replaces a route cache() record a visitor's request wrote", async ({
    page,
  }) => {
    await expectWarmReplacesCachedRecord(page, fixture());
  });

  test("a route that reads cookies() reports skipped-personalized and stores nothing", async ({
    page,
  }) => {
    await expectWarmOfCookieReaderStoresNothing(page, fixture());
  });

  test("a route handler calling router.prerender({ env }) with no origin warms on the request's origin, on-demand and plain targets in one batch", async ({
    page,
  }) => {
    await expectMixedBatchWarmsOnTheRequestOrigin(page, fixture());
  });

  test("onlyIfStale leaves a warmed shell alone and reports already-fresh", async ({
    page,
  }) => {
    await expectOnlyIfStaleWarmLeavesFreshShellAlone(page, fixture());
  });

  // The trigger's localStore=1 makes the gate read a shipped
  // MemorySegmentCacheStore (scope "local"). Production refuses it; the dev
  // rule counts the memory store as shared under the Vite dev server.
  if (f.mode === "build") {
    test("a warm against a store with scope local is refused: nothing renders, nothing is stored", async ({
      page,
    }) => {
      await expectWarmOfLocalStoreIsRefused(page, fixture());
    });
  } else {
    test("under the dev server a warm against the local memory store runs", async ({
      page,
    }) => {
      await expectDevWarmOfLocalMemoryStoreRuns(page, fixture());
    });
  }
}

test.describe("prerender warm (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });
  runPrerenderWarmSpec(f);
});

test.describe("prerender warm (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
    isolatedServer: true,
  });
  runPrerenderWarmSpec(f);
});
