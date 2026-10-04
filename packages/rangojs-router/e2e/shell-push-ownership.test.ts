import { test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import {
  expectPinlessHitKeepsRunPushWithRunData,
  expectReplayDeliversDeferredPush,
  expectReplayKeepsCapturedPushWithPinnedData,
  type PushOwnershipFixture,
} from "@shared/e2e";

// A loader's data and the handle values it pushed come from one run on every
// replay of a PPR shell (issues #1001, #1003), in a real browser. The fixture
// is test-app/src/urls/shell-push-ownership.tsx; the bodies are shared with
// tests/cloudflare-basic/e2e/ppr-push-ownership.test.ts. Every path, the
// ones a browser adds nothing to included, is pinned through
// serveShellRequest in
// src/testing/__tests__/serve-shell-request-push-ownership.rsc-test.tsx.
//
// Own isolatedServer, like the other shell suites: captures are background
// tasks of this suite's requests only. Each test owns its ?probe=.

function runPushOwnershipSpec(f: Fixture) {
  const fixture = (): PushOwnershipFixture => ({
    pinnedUrl: f.url("/shell-push/pinned"),
    cappedUrl: f.url("/shell-push/capped"),
    deferredUrl: f.url("/shell-push/deferred"),
    bumpUrl: f.url("/shell-push/__bump"),
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
}

test.describe("shell push ownership (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });
  runPushOwnershipSpec(f);
});

test.describe("shell push ownership (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
    isolatedServer: true,
  });
  runPushOwnershipSpec(f);
});
