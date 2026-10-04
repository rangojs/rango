import { test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  expectLateBoundaryHandleReaderHydratesClean,
  expectPinlessHitKeepsRunPushWithRunData,
  expectReplayDeliversDeferredPush,
  expectReplayKeepsCapturedPushWithPinnedData,
  expectShellHitHydratesFromRecord,
  type PushOwnershipFixture,
} from "@shared/e2e";

// A loader's data and the handle values it pushed come from one run on every
// replay of a PPR shell (issues #1001, #1003), on workerd with CFCacheStore.
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

    test("a useHandle reader inside a live loader's loading boundary hydrates clean on a document MISS and on a shell HIT (#1035)", async ({
      page,
    }) => {
      await expectLateBoundaryHandleReaderHydratesClean(page, fixture());
    });
  });
}

describePprPushOwnership("dev");
describePprPushOwnership("build");
