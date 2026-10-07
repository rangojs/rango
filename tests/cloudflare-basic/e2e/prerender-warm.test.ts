import { test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
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
// Prerender(..., { onDemand }) is warmed through the request handler, on
// workerd with CFCacheStore over KV (scope "global"). The fixture is
// src/pages/prerender-warm.tsx and the /warm routes; the bodies are shared
// with packages/rangojs-router/e2e/prerender-warm.test.ts.
//
// Serial: captures are background tasks of this suite's requests. Each test
// owns its ?probe=, and so its cache keys (dev and production share the
// miniflare KV).
test.describe.configure({ mode: "serial" });

function describePrerenderWarm(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";

  test.describe(`prerender warm (${label})`, () => {
    const f = useFixture({ root: ".", mode });
    const fixture = (): PrerenderWarmFixture => ({
      shellUrl: f.url("/warm/shell"),
      cachedUrl: f.url("/warm/cached"),
      personalUrl: f.url("/warm/personal"),
      triggerUrl: f.url("/__test/warm-trigger"),
      bumpUrl: f.url("/__test/warm-bump"),
      onDemandPath: (slug) => `/guides/${slug}`,
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

    // localStore=1 builds the app store without KV: a CFCacheStore declares
    // scope "local" then. The dev rule admits only a MemorySegmentCacheStore,
    // so dev refuses it too.
    test("a warm against a KV-less CFCacheStore (scope local) is refused: nothing renders, nothing is stored", async ({
      page,
    }) => {
      await expectWarmOfLocalStoreIsRefused(page, fixture());
    });
  });
}

describePrerenderWarm("dev");
describePrerenderWarm("build");
