import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

// Vite 8 superseded vite-tsconfig-paths with a native `resolve.tsconfigPaths`
// flag (off by default). The Static page (/static-page) and Prerender page
// (/docs) import "@native/marker", which has NO resolve.alias mirror and NO
// resolveId plugin -- it resolves ONLY via the tsconfig "@native/*" path under
// `resolve.tsconfigPaths: true`. Static/Prerender handlers render in the Node
// discovery temp server (on-demand in dev, at build time in production), so the
// "@native/*" specifier only resolves if the native tsconfigPaths flag is
// forwarded into the discovery runner -- the data-slice counterpart to the
// resolveId-plugin forwarding tested by prerender's `@parity` markers.

const MARKER = "native-tsconfig-paths-ok";

test.describe("native tsconfigPaths resolution (dev mode)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("native tsconfigPaths resolves in Static handler", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-page"));
    await waitForHydration(page);

    await expect(testId(page, "static-page-native")).toHaveText(MARKER);
  });

  test("native tsconfigPaths resolves in Prerender handler", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/docs"));
    await waitForHydration(page);

    await expect(testId(page, "docs-native")).toHaveText(MARKER);
  });
});

test.describe("native tsconfigPaths resolution (production build)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("native tsconfigPaths resolves in build-time Static handler", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-page"));
    await waitForHydration(page);

    await expect(testId(page, "static-page-native")).toHaveText(MARKER);
  });

  test("native tsconfigPaths resolves in build-time Prerender handler", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/docs"));
    await waitForHydration(page);

    await expect(testId(page, "docs-native")).toHaveText(MARKER);
  });
});
