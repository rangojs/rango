import { test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  expectActionReplacesBakedTitle,
  expectBackRestoresBakedTitle,
  expectBuildShellHitKeepsPromiseLoaderPush,
  expectBuildShellHitKeepsSettledLoaderPush,
  expectLateBoundaryHandleReaderHydratesClean,
  expectLoaderAwaitedTitleInShellHtml,
  expectLoaderPromiseTitleInShellHtml,
  expectPinlessHitHydratesClean,
  expectPinlessHitKeepsRunPushWithRunData,
  expectPrerenderShellHitKeepsPromisePush,
  expectReplayDeliversDeferredPush,
  expectReplayKeepsCapturedPushWithPinnedData,
  expectShellHitHydratesFromRecord,
  expectShellHitKeepsSettledLoaderPush,
  expectSlowDeferredPushRefusesCapture,
  expectSuspendedHandleReaderHydratesWithBakedPush,
  type LoaderTitleFixture,
  type PrerenderPushFixture,
  type PushOwnershipFixture,
} from "@shared/e2e";

// A loader's data and the handle values it pushed come from one run on every
// replay of a PPR shell (issues #1001, #1003), a Prerender + ppr shell
// hydrates with them too (#1057), and an ssr: false loader's pushed promise
// bakes into the shell (#1182), on workerd with CFCacheStore.
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
      suspendedUrl: f.url("/ppr-push/suspended"),
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

    test("dc-t89: a document HIT of an entry without loader pins hydrates clean with the data its HTML was rendered from", async ({
      page,
    }) => {
      await expectPinlessHitHydratesClean(page, fixture());
    });

    test("a document HIT hydrates clean from the shell's record, a deferred push included, and nothing changes after hydration (#1035, #1182)", async ({
      page,
    }) => {
      await expectShellHitHydratesFromRecord(page, fixture());
    });

    test("a deferred push slower than ppr.captureTimeout refuses the shell capture, as a handler's does (#1182)", async ({
      page,
    }) => {
      await expectSlowDeferredPushRefusesCapture(page, fixture());
    });

    test("a useHandle reader inside a live loader's loading boundary hydrates clean with an ssr false loader's baked promise push (#1182)", async ({
      page,
    }) => {
      await expectSuspendedHandleReaderHydratesWithBakedPush(page, fixture());
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

    test("a Prerender + ppr shell HIT hydrates with a promise push next to the settled push, and nothing arrives after hydration (#1057, #1182)", async ({
      page,
    }) => {
      await expectPrerenderShellHitKeepsPromisePush(page, prerenderFixture());
    });

    test("a Prerender + ppr build-time shell HIT has the promise push of an ssr false loader in its HTML (#1182)", async ({
      page,
    }) => {
      await expectBuildShellHitKeepsPromiseLoaderPush(page, prerenderFixture());
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

    const titleFixture = (): LoaderTitleFixture => ({
      metaPromiseUrl: f.url("/ppr-push/meta-promise"),
      metaAwaitedUrl: f.url("/ppr-push/meta-awaited"),
      bumpUrl: f.url("/__test/ppr-push-bump"),
      homeUrl: f.url("/"),
    });

    test("#1182 control: a shell HIT's HTML has the title an ssr false loader awaited before the push", async ({
      page,
    }) => {
      await expectLoaderAwaitedTitleInShellHtml(page, titleFixture());
    });

    test("#1182 expectation: a shell HIT's HTML has the title an ssr false loader pushed as a promise", async ({
      page,
    }) => {
      await expectLoaderPromiseTitleInShellHtml(page, titleFixture());
    });

    test("#1182: Back to a shell HIT page restores its baked title from the history cache", async ({
      page,
    }) => {
      await expectBackRestoresBakedTitle(page, titleFixture());
    });

    test("#1182: an action that re-runs the loader replaces the baked title", async ({
      page,
    }) => {
      await expectActionReplacesBakedTitle(page, titleFixture());
    });
  });
}

describePprPushOwnership("dev");
describePprPushOwnership("build");
