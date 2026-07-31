import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { ROUTE_REDISCOVERY_PATTERN, writeFileBumpMtime } from "@shared/e2e";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

/**
 * Cloudflare HMR route-mutation tests.
 *
 * Covers two contracts that must both stay fresh when route definitions are
 * edited in cloudflare dev:
 *
 * 1. Type generation: editing the route definitions re-runs discovery (via the
 *    temp Node RSC runner, since workerd has no module runner) and regenerates
 *    `router.named-routes.gen.ts`. Driven by the plugin's route-file watcher.
 *
 * 2. Live serving: workerd serves the newly added/removed/renamed route on the
 *    next request without a manual restart. workerd resolves the request
 *    handler per request via `runner.import("virtual:cloudflare/worker-entry")`
 *    against the runner-worker singleton's module cache. Route-definition
 *    modules have no `import.meta.hot` boundary, so Vite never sends the worker
 *    an HMR update for them; the cached entry chain (entry -> router -> urls ->
 *    createRouter) is never evicted and the worker keeps serving the stale
 *    router. The rango plugin closes this gap: after discovery completes it
 *    sends a `full-reload` to the `rsc` (workerd) environment
 *    (`forceCloudflareWorkerReload` in src/vite/router-discovery.ts), which
 *    clears the runner's evaluatedModules so the next request re-runs
 *    createRouter() with the new routes. This is the scoped, programmatic
 *    equivalent of the dev-server `r`+enter restart.
 *
 * Local-only: route-file watching is unreliable on GH Actions overlayfs.
 * There is no production counterpart: HMR is dev-only (the fix lives in
 * configureServer and never runs in a built worker); production route serving
 * is covered by the rest of the cloudflare-basic e2e suite.
 *
 * Mutations are written via writeFileBumpMtime (shared @shared/e2e): an
 * in-place write + strictly monotonic mtime so the watcher cannot coalesce or
 * drop the change event.
 *
 * Serving markers: a freshly-served route renders `data-testid="about-page"`
 * (the routes below mount AboutPage); a stale/absent route falls through to the
 * `path("/*", CatchAllPage)` wildcard, rendering `data-testid="catch-all-page"`.
 */
test.describe.serial("hmr-route-mutations (types + live serving)", () => {
  test.skip(
    !!process.env.CI,
    "Skipped in CI — inotify unreliable on GH Actions",
  );
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test.setTimeout(90000);

  // Allow time for the file-change -> debounce -> discovery -> gen-write cycle
  // and the subsequent workerd full-reload to land.
  const GEN_TIMEOUT = 30000;

  function urlsPath() {
    return path.join(f.root, "src/urls.tsx");
  }
  function clientUrlsPath() {
    return path.join(f.root, "src/client-urls/urls.tsx");
  }
  function genPath() {
    return path.join(f.root, "src/router.named-routes.gen.ts");
  }
  function readUrls() {
    return fs.readFileSync(urlsPath(), "utf-8");
  }
  function readClientUrls() {
    return fs.readFileSync(clientUrlsPath(), "utf-8");
  }
  function readGen() {
    return fs.readFileSync(genPath(), "utf-8");
  }

  // Poll the generated named-routes file until it does (or does not) contain a
  // snippet. The gen file is rewritten by the discovery pass the route-file
  // watcher triggers on each edit.
  async function expectGen(snippet: string, present: boolean) {
    await expect
      .poll(() => readGen().includes(snippet), { timeout: GEN_TIMEOUT })
      .toBe(present);
  }

  // Poll the dev server until the route is served by the expected page. After a
  // route edit the worker re-evaluates createRouter() on the next request once
  // the plugin's full-reload lands, so this converges shortly after expectGen.
  // The Accept: text/html header is required: without it the worker returns the
  // RSC Flight payload (no literal data-testid attributes) instead of SSR HTML,
  // so the marker check would never match.
  async function expectServed(
    route: string,
    marker: "about-page" | "catch-all-page" | "client-urls-detail",
  ) {
    await expect
      .poll(
        async () => {
          try {
            const res = await fetch(f.url(route), {
              headers: { Accept: "text/html" },
              signal: AbortSignal.timeout(1_000),
            });
            const body = await res.text();
            return body.includes(`data-testid="${marker}"`);
          } catch {
            return false;
          }
        },
        { timeout: GEN_TIMEOUT },
      )
      .toBe(true);
  }

  const originalContents = new Map<string, string>();
  let originalGenBaseline = "";

  function recordOriginal(filePath: string) {
    if (!originalContents.has(filePath)) {
      originalContents.set(filePath, fs.readFileSync(filePath, "utf-8"));
    }
  }

  // Mutate urls.tsx, recording the pre-mutation content for restoration.
  function mutateUrls(content: string) {
    recordOriginal(urlsPath());
    writeFileBumpMtime(urlsPath(), content);
  }

  // Restore git-tracked sources in case a prior crashed run left files dirty,
  // and snapshot the gen-file baseline so afterAll can force it back (a dirty
  // gen file would fail typecheck).
  test.beforeAll(() => {
    try {
      execSync("git checkout -- src/urls.tsx src/router.named-routes.gen.ts", {
        cwd: f.root,
        stdio: "ignore",
      });
    } catch {}
    try {
      const repoRoot = execSync("git rev-parse --show-toplevel", {
        cwd: f.root,
        encoding: "utf-8",
      }).trim();
      const rel = path.relative(repoRoot, genPath());
      originalGenBaseline = execSync(`git show HEAD:${rel}`, {
        cwd: f.root,
        encoding: "utf-8",
      });
    } catch {}
  });

  test.afterEach(async () => {
    if (originalContents.size === 0) return;
    const restoredClientUrls = originalContents.has(clientUrlsPath());
    const entries = [...originalContents];
    originalContents.clear();
    for (const [filePath, content] of entries) {
      writeFileBumpMtime(filePath, content);
    }
    // Wait for the gen file to converge all the way back to the committed
    // baseline so the next test starts clean. A partial match (just the about
    // route present) would pass while nested route types from include/remove
    // tests are still stale, letting the next test start against a
    // half-restored gen file or stale worker table and masking failures. Fall
    // back to the about-route check only if the baseline snapshot (git show in
    // beforeAll) was unavailable.
    if (originalGenBaseline) {
      await expect
        .poll(() => readGen(), { timeout: GEN_TIMEOUT })
        .toBe(originalGenBaseline);
    } else {
      await expect
        .poll(() => readGen(), { timeout: GEN_TIMEOUT })
        .toContain('about: "/about"');
    }
    await expectServed("/about", "about-page");
    if (restoredClientUrls) {
      await expectServed("/__client-urls/restored", "client-urls-detail");
    }
  });

  // Force the gen file back to its committed baseline on suite exit, even if
  // the watcher didn't regenerate it before shutdown.
  test.afterAll(() => {
    if (originalGenBaseline) {
      fs.writeFileSync(genPath(), originalGenBaseline, "utf-8");
    }
  });

  // Warmup: the first route edit after a clean vite cache can trigger Vite's
  // dep optimizer. Add then remove a throwaway route to absorb that cycle so
  // subsequent tests see clean discovery passes. Manages its own restore.
  test("warmup: absorb dep-optimizer cycle on first route edit", async () => {
    const content = readUrls();
    const modified = content.replace(
      'path("/about", AboutPage, { name: "about" }),',
      `path("/about", AboutPage, { name: "about" }),
        path("/hmr-warmup", AboutPage, { name: "hmrWarmup" }),`,
    );
    expect(modified).not.toBe(content);
    writeFileBumpMtime(urlsPath(), modified);
    await expectGen('hmrWarmup: "/hmr-warmup"', true);
    writeFileBumpMtime(urlsPath(), content);
    await expectGen("hmrWarmup", false);
  });

  // Convergence guard only: this fixture is far smaller than the app that
  // exhausted the heap, so it stays green even without the reload bounding.
  // The bounded-work pins are the stale-probe unit test
  // (src/__tests__/static-id-fallback.test.ts) and dev-discovery-probe.test.ts.
  test("repeated clientUrls route-shape edits converge without restarting workerd", async () => {
    const original = readClientUrls();
    const oldPattern = 'path("/:slug", ClientUrlsDetail';
    const newPattern = 'path("/entry/:slug", ClientUrlsDetail';
    expect(original).toContain(oldPattern);
    recordOriginal(clientUrlsPath());

    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        writeFileBumpMtime(
          clientUrlsPath(),
          original.replace(oldPattern, newPattern),
        );
        await expectServed(
          `/__client-urls/entry/hmr-${cycle}`,
          "client-urls-detail",
        );
        await expectServed(`/__client-urls/hmr-${cycle}`, "catch-all-page");

        writeFileBumpMtime(clientUrlsPath(), original);
        await expectServed(`/__client-urls/hmr-${cycle}`, "client-urls-detail");
        await expectServed(
          `/__client-urls/entry/hmr-${cycle}`,
          "catch-all-page",
        );
      }
    } finally {
      writeFileBumpMtime(clientUrlsPath(), original);
    }

    await expectServed("/__client-urls/restored", "client-urls-detail");
    originalContents.delete(clientUrlsPath());
  });

  test("regenerates types and serves a newly added route", async () => {
    await expectGen("hmrTest", false);
    // Before the add the path falls through to the wildcard catch-all.
    await expectServed("/hmr-test-route", "catch-all-page");
    mutateUrls(
      readUrls().replace(
        'path("/about", AboutPage, { name: "about" }),',
        `path("/about", AboutPage, { name: "about" }),
        path("/hmr-test-route", AboutPage, { name: "hmrTest" }),`,
      ),
    );
    await expectGen('hmrTest: "/hmr-test-route"', true);
    // After the add workerd must serve the new route without a manual restart.
    await expectServed("/hmr-test-route", "about-page");
  });

  test("drops types and stops serving a removed route", async () => {
    await expectGen('about: "/about"', true);
    await expectServed("/about", "about-page");
    mutateUrls(
      readUrls().replace(
        'path("/about", AboutPage, { name: "about" }),',
        "// removed for HMR test",
      ),
    );
    await expectGen('about: "/about"', false);
    // The removed path now falls through to the wildcard catch-all.
    await expectServed("/about", "catch-all-page");
  });

  test("converges an open page and a stale document when the viewed route is removed", async ({
    page,
  }) => {
    // The prior test removes then restores /about; the gen file reconverges
    // before the worker finishes its reload, so wait for the worker to actually
    // serve /about again before driving the browser to it (otherwise the first
    // navigation can land on the catch-all).
    await expectServed("/about", "about-page");
    const initialResponse = await page.goto(f.url("/about"));
    expect(initialResponse).not.toBeNull();
    await expect(page.getByTestId("about-page")).toBeVisible();
    const staleBody = await initialResponse!.body();
    const staleHeaders = { ...initialResponse!.headers() };
    delete staleHeaders["content-encoding"];
    delete staleHeaders["content-length"];
    delete staleHeaders["transfer-encoding"];
    // Remove the route the page is currently displaying. Editing a route
    // definition (urls.tsx has no HMR boundary, unlike the component-content
    // edits in hmr.test.ts that update in-page without a reload) triggers a
    // full-document reload, which lands on the catch-all now served by the
    // reloaded worker. Assert the end state: the stale About tree is gone and
    // the catch-all renders.
    mutateUrls(
      readUrls().replace(
        'path("/about", AboutPage, { name: "about" }),',
        "// removed for HMR reload test",
      ),
    );
    await expectGen('about: "/about"', false);
    await expectServed("/about", "catch-all-page");
    await expect(page.getByTestId("catch-all-page")).toBeVisible({
      timeout: GEN_TIMEOUT,
    });

    // Model the race deterministically after the ready event has already fired:
    // boot one captured pre-swap document, then let subsequent navigations hit
    // the live worker. Its startup hot-channel query must notice that the
    // document is stale and request exactly one fresh document.
    let aboutDocumentRequests = 0;
    let staleDocumentServed = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (
        !request.isNavigationRequest() ||
        new URL(request.url()).pathname !== "/about"
      ) {
        await route.continue();
        return;
      }

      aboutDocumentRequests++;
      if (!staleDocumentServed) {
        staleDocumentServed = true;
        await route.fulfill({
          status: initialResponse!.status(),
          headers: staleHeaders,
          body: staleBody,
        });
        return;
      }
      await route.continue();
    });
    await page.goto(f.url("/about")).catch(() => {
      // The corrective reload may supersede this intentionally stale navigation.
    });
    expect(staleDocumentServed).toBe(true);
    await expect
      .poll(() => aboutDocumentRequests, { timeout: GEN_TIMEOUT })
      .toBe(2);
    // /about now falls through to the wildcard catch-all, rendered in-page;
    // the stale About page must be gone.
    await expect(page.getByTestId("catch-all-page")).toBeVisible({
      timeout: GEN_TIMEOUT,
    });
    await expect(page.getByTestId("about-page")).toHaveCount(0);
  });

  test("converges an open 404 when its route is added", async ({ page }) => {
    const response = await page.goto(f.url("/blog/hmr-stale-404"));
    expect(response?.status()).toBe(404);
    await expect(
      page.getByRole("heading", { name: "Not Found" }),
    ).toBeVisible();

    mutateUrls(
      readUrls().replace(
        'path("/blog/:slug", BlogPostPage, {',
        `path("/blog/hmr-stale-404", AboutPage, { name: "hmrStale404" }),
            path("/blog/:slug", BlogPostPage, {`,
      ),
    );
    await expectGen('hmrStale404: "/blog/hmr-stale-404"', true);
    await expectServed("/blog/hmr-stale-404", "about-page");
    await expect(page.getByTestId("about-page")).toBeVisible({
      timeout: GEN_TIMEOUT,
    });
  });

  test("preserves an open document when the route shape is unchanged", async ({
    page,
  }) => {
    let aboutDocumentRequests = 0;
    page.on("request", (request) => {
      if (
        request.isNavigationRequest() &&
        new URL(request.url()).pathname === "/about"
      ) {
        aboutDocumentRequests++;
      }
    });

    await page.goto(f.url("/about"));
    await expect(page.getByTestId("about-page")).toBeVisible();
    const outputOffset = f.proc().stdout().length;
    mutateUrls(
      readUrls().replace(
        "// Prefixed wildcard before the root catch-all",
        "// Unchanged route-shape HMR test: prefixed wildcard before the root catch-all",
      ),
    );

    await expect
      .poll(
        () =>
          ROUTE_REDISCOVERY_PATTERN.test(f.proc().stdout().slice(outputOffset)),
        { timeout: GEN_TIMEOUT },
      )
      .toBe(true);
    await page.waitForTimeout(500);
    expect(aboutDocumentRequests).toBe(1);
    await expect(page.getByTestId("about-page")).toBeVisible();
  });

  test("updates types and serves the new path when a route path is renamed", async () => {
    mutateUrls(
      readUrls().replace(
        'path("/about", AboutPage, { name: "about" }),',
        'path("/about-us", AboutPage, { name: "aboutUs" }),',
      ),
    );
    await expectGen('aboutUs: "/about-us"', true);
    await expectGen('about: "/about"', false);
    // New path serves the page; old path falls through to the catch-all.
    await expectServed("/about-us", "about-page");
    await expectServed("/about", "catch-all-page");
  });

  test("updates types when only the URL changes (name preserved)", async () => {
    mutateUrls(
      readUrls().replace(
        'path("/counter", CounterPage, { name: "counter" }),',
        'path("/counter-v2", CounterPage, { name: "counter" }),',
      ),
    );
    await expectGen('counter: "/counter-v2"', true);
  });

  test("updates types when only the route name changes (path preserved)", async () => {
    await expectGen('about: "/about"', true);
    mutateUrls(
      readUrls().replace(
        'path("/about", AboutPage, { name: "about" }),',
        'path("/about", AboutPage, { name: "aboutRenamed" }),',
      ),
    );
    await expectGen('aboutRenamed: "/about"', true);
    await expectGen('about: "/about"', false);
  });

  test("drops nested types when an include is removed", async () => {
    await expectGen("composition.index", true);
    mutateUrls(
      readUrls().replace(
        /include\("\/composition", compositionPatterns,\s*\{[^}]*name:\s*"composition"[^}]*\}\s*\),/,
        "// include removed for HMR test",
      ),
    );
    await expectGen("composition.index", false);
  });

  test("restores nested types when an include is re-added", async () => {
    const original = readUrls();
    mutateUrls(
      original.replace(
        /include\("\/composition", compositionPatterns,\s*\{[^}]*name:\s*"composition"[^}]*\}\s*\),/,
        "// include removed for HMR test",
      ),
    );
    await expectGen("composition.index", false);
    // Restore the include in-test (afterEach also restores; this pins the
    // re-add path explicitly).
    writeFileBumpMtime(urlsPath(), original);
    await expectGen("composition.index", true);
  });

  test("converges types to the final state after rapid sequential edits", async () => {
    recordOriginal(urlsPath());
    const original = readUrls();
    const variant = (suffix: string, name: string) =>
      original.replace(
        'path("/about", AboutPage, { name: "about" }),',
        `path("/about", AboutPage, { name: "about" }),
        path("/burst-${suffix}", AboutPage, { name: "${name}" }),`,
      );
    // Three rapid writes; the gen file must converge to the LAST write only.
    writeFileBumpMtime(urlsPath(), variant("a", "burstA"));
    writeFileBumpMtime(urlsPath(), variant("b", "burstB"));
    writeFileBumpMtime(urlsPath(), variant("c", "burstC"));
    await expectGen('burstC: "/burst-c"', true);
    await expectGen("burstA", false);
    await expectGen("burstB", false);
    // The worker converges to the final route too, not an intermediate one.
    await expectServed("/burst-c", "about-page");
    await expectServed("/burst-a", "catch-all-page");
  });

  test("a failed discovery leaves the gen file intact and recovers on the next valid edit", async () => {
    // Baseline.
    await expectGen('about: "/about"', true);

    const valid = readUrls();
    // Snapshot the dev server's stderr length so we can detect the failure THIS
    // edit causes rather than a stale one from an earlier test.
    const stderrBefore = f.proc().stderr().length;
    // A syntax error makes runtime rediscovery's import throw. The failed cycle
    // sets lastDiscoveryError, preserves the last-good manifest, and gates off
    // the workerd reload (the success path never runs) so the fix does not
    // force-reload the worker onto broken code. The gen file is left intact:
    // writeRouteTypesFiles never runs after discoverRouters throws, and the
    // static write is skipped in cloudflare HMR. (Vite still serves the route's
    // transform error while urls.tsx is broken — the reload gate governs the
    // worker eviction, not Vite's own transform pipeline.)
    mutateUrls(valid + '\nconst __brokenForHmrTest = "unterminated\n');
    // Wait for the failed discovery cycle to actually run before editing again.
    // Without this the broken and recovery writes can coalesce inside the 100ms
    // debounce into a single successful cycle, never exercising the failure
    // path. The failed cycle logs this on the dev server's stderr.
    await expect
      .poll(() => f.proc().stderr().slice(stderrBefore), {
        timeout: GEN_TIMEOUT,
      })
      .toContain("Runtime re-discovery failed");
    // The gen file must stay at the last-good baseline through the failed cycle.
    expect(readGen()).toContain('about: "/about"');

    // Fixing the source (with a renamed path) re-runs discovery successfully,
    // clears the error, and now fires the gated reload — so types regenerate and
    // the worker serves the new route without a manual restart.
    writeFileBumpMtime(
      urlsPath(),
      valid.replace(
        'path("/about", AboutPage, { name: "about" }),',
        'path("/about-recovered", AboutPage, { name: "aboutRecovered" }),',
      ),
    );
    await expectGen('aboutRecovered: "/about-recovered"', true);
    await expectGen('about: "/about"', false);
    await expectServed("/about-recovered", "about-page");
    await expectServed("/about", "catch-all-page");
  });
});
