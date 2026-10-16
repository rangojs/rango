import { rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { checkoutPortOffset } from "@shared/e2e";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

/**
 * #1186: the dep optimizer's RSC reload lands during a cold server's first
 * request, and the re-import is slow (rscReloadProbe() in vite.config.ts).
 * Dev only: a build has no module runner. `readyPath: false` keeps the test's
 * request the server's first.
 */
const PROBE_LOG = "[rango-e2e] rsc-reload-probe: full reload sent";

/**
 * A cold dev server whose first request asks for the reload where `probe`
 * (a RSC_RELOAD_PROBES key in vite.config.ts) loads.
 */
function useReloadServer(probe: "entry" | "discovery", port: number) {
  const cacheDir = path.resolve(`node_modules/.vite-e2e-rsc-reload-${probe}`);
  const clean = () => rmSync(cacheDir, { recursive: true, force: true });
  // Registered before useFixture's hooks, so it runs before the server starts.
  test.beforeAll(clean);
  const f = useFixture({
    root: ".",
    mode: "dev",
    isolatedServer: true,
    readyPath: false,
    command: `./node_modules/.bin/vite dev --port ${port} --strictPort`,
    cliOptions: {
      env: {
        RANGO_E2E_RENDER_TIMEOUT: "1",
        RANGO_E2E_RSC_RELOAD_PROBE: probe,
        RANGO_E2E_VITE_CACHE_DIR: cacheDir,
      },
    },
  });
  test.afterAll(clean);
  return f;
}

// The runner worker dispatches the request only once the re-import is done,
// so it reaches router.fetch with the re-created router registered.
test.describe("dev first request across an RSC runner full reload", () => {
  const f = useReloadServer("entry", 5401 + checkoutPortOffset());

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

// The reload lands after the request entered router.fetch: route discovery
// loads the lazy group after the runner's clear, so a fresh router copy
// registers its revalidate() predicates while the request's copy materializes
// it ("has no server registration" on 0.26.3).
test.describe("dev first request split by an RSC runner full reload", () => {
  const f = useReloadServer("discovery", 5403 + checkoutPortOffset());

  test("the first document re-runs on the router the reload re-created", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    using _ = expectNoPageError(page);

    const slug = "split-by-reload";
    const response = await page.goto(f.url(`/__client-urls-lazy/${slug}`));
    expect(f.proc().stdout()).toContain(PROBE_LOG);
    expect(response?.status()).toBe(200);
    await waitForHydration(page);
    await expect(testId(page, "client-urls-param")).toHaveText(slug);
    await expect(testId(page, "client-urls-loader")).toHaveText(slug);
  });
});
