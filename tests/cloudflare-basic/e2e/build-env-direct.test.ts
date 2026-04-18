import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

// =============================================================================
// Build-time env via `import { env } from "cloudflare:workers"`
// =============================================================================
// Counterpart to build-env.test.ts which uses the `ctx.env` parameter pattern.
// This exercises the direct-import pattern: the `cloudflare:workers` stub's
// `env` export is populated from `globalThis[BUILD_ENV_GLOBAL_KEY]`, which
// router-discovery sets to the resolved `getPlatformProxy().env` proxy when
// `buildEnv: "auto"` is configured. If the bridge weren't wired, `env` would
// be `{}` and `env.KV.put()` would throw during prerender — the build would
// fail before we ever reached Playwright.

test.describe("build-time env via cloudflare:workers import (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("prerendered page shows KV value written via imported env", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/build-env-direct"));
    await waitForHydration(page);

    await expect(testId(page, "build-env-direct-title")).toContainText(
      "Build Env Direct Test",
    );
    await expect(testId(page, "build-env-direct-value")).toHaveText(
      "seeded-via-cf-workers-import",
    );
  });
});

test.describe("build-time env via cloudflare:workers import (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("dev prerender uses buildEnv for imported env too", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/build-env-direct"));
    await waitForHydration(page);

    await expect(testId(page, "build-env-direct-title")).toContainText(
      "Build Env Direct Test",
    );
    await expect(testId(page, "build-env-direct-value")).toHaveText(
      "seeded-via-cf-workers-import",
    );
  });
});
