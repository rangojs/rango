import { test } from "@playwright/test";
import { runPushHandleTests } from "@shared/e2e";
import { useFixture } from "./fixture";
import { expectNoPageError, waitForHydration } from "./helper";

/**
 * Client components push handle values (usePushHandle): a fetch loader's
 * title and crumb, a live value, the frames around a navigation that mounts
 * or unmounts a pusher, a push on a page a view transition holds, a title
 * pushed as the promise of a fetch, and a
 * clientUrls page. Body:
 * tests/shared-e2e/src/push-handle-scenario.ts. Fixtures:
 * test-app/src/urls/push-handle.tsx (/push-handle/*) and
 * test-app/src/urls/push-handle.client-urls.tsx (/push-handle-group).
 */
const OPTIONS = {
  waitForHydration,
  expectNoPageError,
  base: "/push-handle",
  groupBase: "/push-handle-group",
};

test.describe("client components push handle values", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  test.setTimeout(60000);
  runPushHandleTests({
    url: (pathname) => f.url(pathname),
    ...OPTIONS,
  });
});

test.describe("client components push handle values (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  test.setTimeout(60000);
  runPushHandleTests({
    url: (pathname) => f.url(pathname),
    ...OPTIONS,
  });
});
