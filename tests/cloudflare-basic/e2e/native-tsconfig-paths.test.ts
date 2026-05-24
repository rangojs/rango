import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

// Vite 8 superseded vite-tsconfig-paths with a native `resolve.tsconfigPaths`
// flag (off by default). The Static page (/static-content) and Prerender page
// (/releases) import "@native/marker", which has NO resolve.alias mirror and NO
// resolveId plugin -- it resolves ONLY via the tsconfig "@native/*" path under
// `resolve.tsconfigPaths: true`. In cloudflare dev, Static/Prerender handlers
// run in the Node temp server via the prerender endpoint; in production they are
// rendered at build time through the same temp server. Both paths only resolve
// "@native/*" if the native tsconfigPaths flag is forwarded into the discovery
// runner (the data-slice counterpart to the resolveId-plugin forwarding).

const MARKER = "native-tsconfig-paths-ok";

test.describe("native tsconfigPaths resolution (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("native tsconfigPaths resolves in Static handler", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content"));
    await waitForHydration(page);

    await expect(testId(page, "static-index-native")).toHaveText(MARKER);
  });

  test("native tsconfigPaths resolves in Prerender handler", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/releases"));
    await waitForHydration(page);

    await expect(testId(page, "releases-native")).toHaveText(MARKER);
  });
});

test.describe("native tsconfigPaths resolution (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("native tsconfigPaths resolves in build-time Static handler", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content"));
    await waitForHydration(page);

    await expect(testId(page, "static-index-native")).toHaveText(MARKER);
  });

  test("native tsconfigPaths resolves in build-time Prerender handler", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/releases"));
    await waitForHydration(page);

    await expect(testId(page, "releases-native")).toHaveText(MARKER);
  });
});
