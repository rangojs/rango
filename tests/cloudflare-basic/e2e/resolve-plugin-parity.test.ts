import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

// Issue #500: the cloudflare discovery runner must honor the user's third-party
// resolveId plugins (e.g. vite-tsconfig-paths). The Static page (/static-content)
// and Prerender page (/releases) import "@parity/marker", which is resolved ONLY
// by the `test-parity-alias` resolveId plugin in vite.config.ts -- there is no
// resolve.alias mirror. In cloudflare dev, Static/Prerender handlers run in the
// Node temp server via the prerender endpoint; in production they are rendered at
// build time through the same temp server. Both paths only resolve "@parity/*"
// if user resolveId plugins are forwarded into the discovery runner.

const MARKER = "resolveid-plugin-parity-ok";

test.describe("resolveId-plugin parity (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("alias-only resolveId plugin resolves in Static handler", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content"));
    await waitForHydration(page);

    await expect(testId(page, "static-index-parity")).toHaveText(MARKER);
  });

  test("alias-only resolveId plugin resolves in Prerender handler", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/releases"));
    await waitForHydration(page);

    await expect(testId(page, "releases-parity")).toHaveText(MARKER);
  });
});

test.describe("resolveId-plugin parity (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("alias-only resolveId plugin resolves in build-time Static handler", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content"));
    await waitForHydration(page);

    await expect(testId(page, "static-index-parity")).toHaveText(MARKER);
  });

  test("alias-only resolveId plugin resolves in build-time Prerender handler", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/releases"));
    await waitForHydration(page);

    await expect(testId(page, "releases-parity")).toHaveText(MARKER);
  });
});
