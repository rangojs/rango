import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { checkoutPortOffset, writeFileBumpMtime } from "@shared/e2e";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

/**
 * A Cloudflare dev server whose route discovery failed at startup recovers on
 * the next save once the cause is fixed.
 *
 * The worker evaluates every include() on each dev request, and it gets the
 * clientUrls() projections only from a discovery pass. A cold discovery that
 * failed before computing them left every request a 500 ("include() could not
 * resolve the server projection"), and nothing re-ran discovery: the watcher's
 * recovery mode required the Node runner, so only a restart recovered.
 *
 * The failure is injected in the discovery realm only: the temp Node server
 * sets __rscRouterDiscoveryActive while it imports the entry, workerd never
 * does. It stands in for a cold discovery the worker does not share, such as
 * the give-up after three passes split by runner reloads. A throw both realms
 * hit at module evaluation stops @cloudflare/vite-plugin from starting at all.
 *
 * Dev only: the route-file watcher and the discovery temp runner exist only
 * under vite dev. In the hmr project (local only, like the other route-edit
 * tests): it edits src/pages/guides.tsx under a server of its own.
 */
const PORT = 5399 + checkoutPortOffset();
const ROUTE_MODULE = path.resolve("src/pages/guides.tsx");
const GEN_FILE = path.resolve("src/router.named-routes.gen.ts");
const INJECTED =
  "if ((globalThis as { __rscRouterDiscoveryActive?: boolean }).__rscRouterDiscoveryActive) {\n" +
  '  throw new Error("injected cold discovery failure");\n' +
  "}\n";

let originalModule: string;
let originalGen: string;

function restore(): void {
  if (originalModule !== undefined) {
    writeFileSync(ROUTE_MODULE, originalModule);
  }
  if (originalGen !== undefined) writeFileSync(GEN_FILE, originalGen);
}

test.describe("hmr cold discovery recovery (cloudflare)", () => {
  test.skip(
    !!process.env.CI,
    "Skipped in CI — inotify unreliable on GH Actions",
  );

  // Registered before useFixture's hooks, so the server boots on the failure.
  test.beforeAll(() => {
    originalModule = readFileSync(ROUTE_MODULE, "utf-8");
    originalGen = readFileSync(GEN_FILE, "utf-8");
    const lastImport = originalModule.lastIndexOf("\nimport ");
    const insertAt = originalModule.indexOf("\n", lastImport + 1) + 1;
    writeFileSync(
      ROUTE_MODULE,
      originalModule.slice(0, insertAt) +
        INJECTED +
        originalModule.slice(insertAt),
    );
  });

  const f = useFixture({
    root: ".",
    mode: "dev",
    isolatedServer: true,
    readyPath: false,
    command: `./node_modules/.bin/vite dev --port ${PORT} --strictPort`,
    cliOptions: { env: { DEBUG: "rango:discovery" } },
  });

  test.afterAll(restore);

  test("every request fails until the fix, then the server serves again", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const log = () => f.proc().stdout() + f.proc().stderr();
    const status = async (): Promise<number> => {
      try {
        return (await request.get(f.url("/"), { timeout: 10_000 })).status();
      } catch {
        return 0;
      }
    };

    await expect
      .poll(() => log().includes("injected cold discovery failure"), {
        timeout: 30_000,
        message: "the cold discovery should fail on the injected throw",
      })
      .toBe(true);
    await expect
      .poll(status, {
        timeout: 30_000,
        message: "the worker serves 500s while discovery has failed",
      })
      .toBe(500);

    writeFileBumpMtime(ROUTE_MODULE, originalModule);

    await expect
      .poll(status, {
        timeout: 60_000,
        message:
          "the fix should re-run discovery and reload the worker. Still 500: " +
          "the watcher did not rediscover after the failed cold discovery.",
      })
      .toBe(200);
    expect(log()).toContain("hmr: cleared lastDiscoveryError");

    using _ = expectNoPageError(page);
    const slug = "recovered";
    const response = await page.goto(f.url(`/__client-urls/${slug}`));
    expect(response?.status()).toBe(200);
    await waitForHydration(page);
    await expect(testId(page, "client-urls-param")).toHaveText(slug);
  });
});
