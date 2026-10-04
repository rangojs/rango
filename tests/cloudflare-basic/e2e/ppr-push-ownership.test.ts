import { test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  expectBuildShellHitKeepsSettledLoaderPush,
  expectLateBoundaryHandleReaderHydratesClean,
  expectPinlessHitKeepsRunPushWithRunData,
  expectPrerenderShellHitDeliversPromisePush,
  expectReplayDeliversDeferredPush,
  expectReplayKeepsCapturedPushWithPinnedData,
  expectShellHitHydratesFromRecord,
  expectShellHitKeepsSettledLoaderPush,
  expectSlowDeferredPushDoesNotBlockCapture,
  type PrerenderPushFixture,
  type PushOwnershipFixture,
} from "@shared/e2e";

// A loader's data and the handle values it pushed come from one run on every
// replay of a PPR shell (issues #1001, #1003), and a Prerender + ppr shell
// hydrates with them too (#1057), on workerd with CFCacheStore.
// The fixture is src/loaders/ppr-push-ownership.ts and the /ppr-push routes;
// the bodies are shared with
// packages/rangojs-router/e2e/shell-push-ownership.test.ts.
//
// Serial: captures are background tasks of this suite's requests. Each test
// owns its ?probe=, and so its shell key and its generation.
test.describe.configure({ mode: "serial" });

function describePprPushOwnership(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";

  test.describe(`ppr push ownership (${label})`, () => {
    const f = useFixture({ root: ".", mode });
    const fixture = (): PushOwnershipFixture => ({
      pinnedUrl: f.url("/ppr-push/pinned"),
      cappedUrl: f.url("/ppr-push/capped"),
      deferredUrl: f.url("/ppr-push/deferred"),
      slowUrl: f.url("/ppr-push/slow"),
      liveUrl: f.url("/ppr-push/live"),
      bumpUrl: f.url("/__test/ppr-push-bump"),
      homeUrl: f.url("/"),
    });

    test("a navigation that replays the shell keeps the captured push next to the pinned data (#1003)", async ({
      page,
    }) => {
      await expectReplayKeepsCapturedPushWithPinnedData(page, fixture());
    });

    test("a navigation that replays the shell delivers the deferred push of a cached ssr false loader (#1001)", async ({
      page,
    }) => {
      await expectReplayDeliversDeferredPush(page, fixture());
    });

    test("a document HIT of an entry without loader pins shows the run's push next to the run's data", async ({
      page,
    }) => {
      await expectPinlessHitKeepsRunPushWithRunData(page, fixture());
    });

    test("a document HIT hydrates clean from the shell's record and shows a deferred push after hydration (#1035)", async ({
      page,
    }) => {
      await expectShellHitHydratesFromRecord(page, fixture());
    });

    test("a deferred push slower than ppr.captureTimeout does not block the shell capture (#1035)", async ({
      page,
    }) => {
      await expectSlowDeferredPushDoesNotBlockCapture(page, fixture());
    });

    test("a useHandle reader inside a live loader's loading boundary hydrates clean on a document MISS and on a shell HIT (#1035)", async ({
      page,
    }) => {
      await expectLateBoundaryHandleReaderHydratesClean(page, fixture());
    });

    const prerenderFixture = (): PrerenderPushFixture => ({
      preSettledUrl: f.url("/ppr-push/pre-settled"),
      pprSettledUrl: f.url("/ppr-push/ppr-settled"),
      preDeferredUrl: f.url("/ppr-push/pre-deferred"),
      bumpUrl: f.url("/__test/ppr-push-bump"),
    });

    test("a Prerender + ppr shell HIT hydrates with the settled push of a promise-free ssr false loader (#1057)", async ({
      page,
    }) => {
      const fixture = prerenderFixture();
      await expectShellHitKeepsSettledLoaderPush(
        page,
        fixture,
        fixture.preSettledUrl,
      );
    });

    test("a Prerender + ppr build-time shell HIT hydrates with the settled push of a promise-free ssr false loader (#1057)", async ({
      page,
    }) => {
      await expectBuildShellHitKeepsSettledLoaderPush(page, prerenderFixture());
    });

    test("a Prerender + ppr shell HIT delivers a promise push after hydration, next to the settled push it hydrates with (#1057)", async ({
      page,
    }) => {
      await expectPrerenderShellHitDeliversPromisePush(
        page,
        prerenderFixture(),
      );
    });

    test("a ppr shell HIT without Prerender hydrates with the same settled push (control)", async ({
      page,
    }) => {
      const fixture = prerenderFixture();
      await expectShellHitKeepsSettledLoaderPush(
        page,
        fixture,
        fixture.pprSettledUrl,
      );
    });
  });
}

describePprPushOwnership("dev");
describePprPushOwnership("build");
