import { rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { checkoutPortOffset } from "@shared/e2e";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

/**
 * #1186: the dep optimizer's RSC reload lands while a cold server's first
 * request loads the entry, and the re-import is slow (rscReloadProbe() in
 * vite.config.ts). The runner worker dispatches that request only once the
 * re-import is done, so it reaches router.fetch with the re-created router
 * registered. Dev only: a build has no module runner. `readyPath: false`
 * keeps the test's request the server's first.
 */
const PORT = 5401 + checkoutPortOffset();
const CACHE_DIR = path.resolve("node_modules/.vite-e2e-rsc-reload");
const PROBE_LOG = "[rango-e2e] rsc-reload-probe: full reload sent";

function clean(): void {
  rmSync(CACHE_DIR, { recursive: true, force: true });
}

test.describe("dev first request across an RSC runner full reload", () => {
  // Registered before useFixture's hooks, so it runs before the server starts.
  test.beforeAll(clean);

  const f = useFixture({
    root: ".",
    mode: "dev",
    isolatedServer: true,
    readyPath: false,
    command: `./node_modules/.bin/vite dev --port ${PORT} --strictPort`,
    cliOptions: {
      env: {
        RANGO_E2E_RENDER_TIMEOUT: "1",
        RANGO_E2E_RSC_RELOAD_PROBE: "1",
        RANGO_E2E_VITE_CACHE_DIR: CACHE_DIR,
      },
    },
  });

  test.afterAll(clean);

  test("the first clientUrls document renders and hydrates on the router the reload re-created", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    using _ = expectNoPageError(page);

    const slug = "after-reload";
    const response = await page.goto(f.url(`/__client-urls/${slug}`));
    expect(f.proc().stdout()).toContain(PROBE_LOG);
    expect(response?.status()).toBe(200);
    await waitForHydration(page);
    await expect(testId(page, "client-urls-param")).toHaveText(slug);
    await expect(testId(page, "client-urls-loader")).toHaveText(slug);
  });
});
