import { test } from "@playwright/test";
import { runLoaderReadHandlesTests } from "@shared/e2e";
import { useFixture } from "./fixture";
import { expectNoPageError, waitForHydration } from "./helper";

/**
 * A loader read on its own (a group refresh, load()) applies the title and
 * crumb its body pushes, in place of its earlier ones. Body:
 * tests/shared-e2e/src/loader-read-handles-scenario.ts. Fixture:
 * src/pages/loader-read-handles.tsx.
 */
const OPTIONS = {
  waitForHydration,
  expectNoPageError,
  base: "/loader-read-handles",
};

test.describe("a loader read applies its handle pushes", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  test.setTimeout(60000);
  runLoaderReadHandlesTests({
    url: (pathname) => f.url(pathname),
    ...OPTIONS,
  });
});

test.describe("a loader read applies its handle pushes (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  test.setTimeout(60000);
  runLoaderReadHandlesTests({
    url: (pathname) => f.url(pathname),
    ...OPTIONS,
  });
});
