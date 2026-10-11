import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { checkoutPortOffset } from "@shared/e2e";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

/**
 * The route-file watcher of a cold dev server skips another app's urls module
 * written into a dot-directory of its root, so no re-discovery reloads the
 * worker during the server's first request.
 *
 * The cache-version e2e used to write a copy of an app (router.tsx, urls.tsx)
 * into .cache-version-work/ whenever Playwright collected tests. The watcher
 * re-ran discovery for the copy and reloaded the worker, and on a cold server
 * the reload landed during the first request: its later dynamic imports
 * evaluated a second router module graph with empty registries, and the page
 * answered 500 ("include() could not resolve the server projection",
 * "getRequestContext() called outside of a request context").
 *
 * What pins the fix is the watcher's decision on the nested module, read from
 * the DEBUG=rango:discovery log. The page checks (200, hydrates, param and
 * loader render) are the symptom and pass on main too, since the race is
 * timing-dependent; the decision line is the deterministic part.
 *
 * Dev only: the route-file watcher and the worker's module runner exist only
 * under vite dev. `readyPath: false` keeps the first request the server's
 * first.
 */
const PORT = 5397 + checkoutPortOffset();
const NESTED_APP = path.resolve(".rango-e2e-nested-app");
const NESTED_URLS = path.join(NESTED_APP, "src", "urls.tsx");

function writeNestedUrls(): void {
  mkdirSync(path.dirname(NESTED_URLS), { recursive: true });
  writeFileSync(
    NESTED_URLS,
    [
      'import { urls } from "@rangojs/router";',
      "",
      'export const urlpatterns = urls(({ path }) => [path("/", () => null)]);',
      "",
    ].join("\n"),
  );
}

function clean(): void {
  rmSync(NESTED_APP, { recursive: true, force: true });
}

function watcherDecision(log: string): "skipped" | "rediscovered" | "none" {
  if (log.includes(`watcher: skip ${NESTED_URLS}`)) return "skipped";
  if (log.includes(`watcher: ${NESTED_URLS} matches`)) return "rediscovered";
  return "none";
}

test.describe("dev cold start beside another app's router files", () => {
  // Registered before useFixture's hooks, so it runs before the server starts.
  test.beforeAll(clean);

  const f = useFixture({
    root: ".",
    mode: "dev",
    isolatedServer: true,
    readyPath: false,
    command: `./node_modules/.bin/vite dev --port ${PORT} --strictPort`,
    cliOptions: {
      env: { RANGO_E2E_RENDER_TIMEOUT: "1", DEBUG: "rango:discovery" },
    },
  });

  test.afterAll(clean);

  test("the first clientUrls document renders and hydrates while a nested app copy appears", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    using _ = expectNoPageError(page);

    const slug = "cold-start";
    const load = page.goto(f.url(`/__client-urls/${slug}`));
    writeNestedUrls();
    const response = await load;
    expect(response?.status()).toBe(200);
    await waitForHydration(page);
    await expect(testId(page, "client-urls-param")).toHaveText(slug);
    await expect(testId(page, "client-urls-loader")).toHaveText(slug);

    await expect
      .poll(() => watcherDecision(f.proc().stderr()), {
        timeout: 20_000,
        message:
          `expected the watcher to skip ${NESTED_URLS} ("watcher: skip" in the ` +
          `DEBUG=rango:discovery log). "rediscovered": it re-ran discovery for ` +
          `the file. "none": neither line appeared, so check the message text ` +
          `in router-discovery.ts.`,
      })
      .toBe("skipped");
  });
});
