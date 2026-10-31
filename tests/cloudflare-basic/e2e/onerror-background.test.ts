import { test } from "@playwright/test";
import { runOnErrorBackgroundTests } from "@shared/e2e";
import { useFixture } from "./fixture";

// Body: tests/shared-e2e/src/onerror-background-scenario.ts.
test.describe("onError background marker (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runOnErrorBackgroundTests({ url: (pathname) => f.url(pathname) });
});

test.describe("onError background marker (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runOnErrorBackgroundTests({ url: (pathname) => f.url(pathname) });
});
