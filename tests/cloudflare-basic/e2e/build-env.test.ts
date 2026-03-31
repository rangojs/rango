import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

// =============================================================================
// Build-time env: buildEnv: "auto" injects Cloudflare KV at build time
// =============================================================================
// The handler uses ctx.env.KV.put() + ctx.env.KV.get() at build time.
// This proves the full buildEnv pipeline: rango config -> resolveBuildEnv
// -> getPlatformProxy -> thread through matchForPrerender -> BuildContext.env.

test.describe("build-time env via KV (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("page renders KV-seeded content from build-time env", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/build-env"));
    await waitForHydration(page);

    await expect(testId(page, "build-env-title")).toContainText(
      "Build Env Test",
    );
    // Value was written and read via ctx.env.KV at build time
    await expect(testId(page, "build-env-value")).toHaveText(
      "seeded-at-build-time",
    );
    await expect(testId(page, "build-env-build")).toHaveText("true");
  });
});
