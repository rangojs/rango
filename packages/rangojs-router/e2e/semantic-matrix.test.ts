import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

type BuildAxis = "dev" | "prod";
type TransportAxis = "js" | "pe" | "request";
type ExecutionAxis = "full-render" | "action-followup" | "shell-capture";
type ScopeAxis =
  | "in-scope-child"
  | "sibling-orphan"
  | "layout-parallel"
  | "n/a";

type MatrixContext = {
  baseUrl: (path: string) => string;
  build: BuildAxis;
  page: Page;
  request: APIRequestContext;
};

type SemanticMatrixRow = {
  id: string;
  contract: string;
  builds?: BuildAxis[];
  transport: TransportAxis;
  execution: ExecutionAxis;
  scope: ScopeAxis;
  url?: string;
  assert: (ctx: MatrixContext) => Promise<void>;
};

async function openJsPage(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await waitForHydration(page);
}

async function openPePage(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(testId(page, "mw-chain-page")).toBeVisible();
}

async function runJsAction(page: Page): Promise<void> {
  await testId(page, "chain-action-btn").click();
}

async function runPeAction(page: Page): Promise<void> {
  await testId(page, "chain-pe-submit").click();
  await page.waitForLoadState("domcontentloaded");
}

async function parseLoaderCount(page: Page): Promise<number> {
  const text = await testId(page, "loader-count").textContent();
  return Number(text!.replace(/\D/g, ""));
}

async function readTestIdText(page: Page, id: string): Promise<string> {
  return (await testId(page, id).textContent())?.trim() ?? "";
}

async function readResponseJson(
  request: APIRequestContext,
  url: string,
): Promise<any> {
  const response = await request.get(url);
  expect(response.status()).toBe(200);
  return response.json();
}

async function readRouteReport(page: Page): Promise<{
  sawGlobalVar: string | null;
  sawActionCookie: string | null;
}> {
  const report = await testId(page, "handler-route-report").innerText();
  return JSON.parse(report);
}

function rowTitle(row: SemanticMatrixRow): string {
  return `[${row.id}] ${row.transport} | ${row.execution} | ${row.scope} :: ${row.contract}`;
}

const matrixRows: SemanticMatrixRow[] = [
  {
    id: "S1",
    contract: "in-scope child parallel can read handler data on full render",
    transport: "js",
    execution: "full-render",
    scope: "in-scope-child",
    assert: async ({ page }) => {
      await expect(testId(page, "sub-parallel-handler-data")).toHaveText(
        "from-handler",
      );
    },
  },
  {
    id: "S2",
    contract:
      "sibling orphan parallel cannot read path handler data on full render",
    transport: "js",
    execution: "full-render",
    scope: "sibling-orphan",
    assert: async ({ page }) => {
      await expect(testId(page, "orphan-parallel-handler-data")).toHaveText(
        "none",
      );
    },
  },
  {
    id: "S3",
    contract:
      "layout-level parallel sees layout data but not path handler data",
    transport: "js",
    execution: "full-render",
    scope: "layout-parallel",
    assert: async ({ page }) => {
      await expect(testId(page, "parallel-layout-data")).toHaveText(
        "from-main-layout",
      );
      await expect(testId(page, "parallel-handler-data")).toHaveText("none");
    },
  },
  {
    id: "A1",
    contract:
      "JS action follow-up keeps same-request route-middleware visibility during revalidation",
    transport: "js",
    execution: "action-followup",
    scope: "n/a",
    assert: async ({ page }) => {
      await runJsAction(page);
      await expect(testId(page, "layout-action-var")).toHaveText(
        "from-action",
        { timeout: 10000 },
      );
      await expect(testId(page, "loader-action-cookie")).toHaveText("av", {
        timeout: 10000,
      });
      const report = await readRouteReport(page);
      expect(report.sawGlobalVar).toBe("from-global");
      expect(report.sawActionCookie).toBe("av");
    },
  },
  {
    id: "P1",
    contract: "PE action returns HTML document response (not Flight stream)",
    transport: "pe",
    execution: "action-followup",
    scope: "n/a",
    assert: async ({ page }) => {
      await runPeAction(page);
      const content = await page.content();
      expect(content).toMatch(/<!DOCTYPE html>/i);
      expect(content).not.toMatch(/^0:/);
    },
  },
  {
    id: "A2",
    contract:
      "PE action follow-up matches JS action contract for same-request middleware visibility",
    transport: "pe",
    execution: "action-followup",
    scope: "n/a",
    assert: async ({ page }) => {
      await runPeAction(page);
      await expect(testId(page, "layout-action-var")).toHaveText("from-action");
      await expect(testId(page, "loader-action-cookie")).toHaveText("av");
      const report = await readRouteReport(page);
      expect(report.sawGlobalVar).toBe("from-global");
      expect(report.sawActionCookie).toBe("av");
    },
  },
  {
    id: "R1",
    contract:
      "partial action revalidation does not preserve upstream ctx.set data when the producer segment does not rerun",
    transport: "js",
    execution: "action-followup",
    scope: "in-scope-child",
    url: "/revalidation-contract",
    assert: async ({ page }) => {
      await expect(testId(page, "revalidation-contract-upstream")).toHaveText(
        "from-layout",
      );
      await expect(
        testId(page, "revalidation-contract-action-cookie"),
      ).toHaveText("none");

      await testId(page, "revalidation-contract-action-btn").click();

      await expect(
        testId(page, "revalidation-contract-action-cookie"),
      ).toHaveText("set", { timeout: 10000 });
      await expect(testId(page, "revalidation-contract-upstream")).toHaveText(
        "none",
        { timeout: 10000 },
      );
    },
  },
  {
    id: "S4",
    contract:
      "PE action follow-up keeps in-scope child visibility to handler data",
    transport: "pe",
    execution: "action-followup",
    scope: "in-scope-child",
    assert: async ({ page }) => {
      await runPeAction(page);
      await expect(testId(page, "sub-parallel-handler-data")).toHaveText(
        "from-handler",
      );
    },
  },
  {
    id: "S5",
    contract:
      "PE action follow-up keeps sibling orphan boundary (no path handler data leak)",
    transport: "pe",
    execution: "action-followup",
    scope: "sibling-orphan",
    assert: async ({ page }) => {
      await runPeAction(page);
      await expect(testId(page, "orphan-parallel-handler-data")).toHaveText(
        "none",
      );
    },
  },
  {
    id: "S6",
    contract:
      "PE action follow-up: layout-level parallel sees layout data but not path handler data",
    transport: "pe",
    execution: "action-followup",
    scope: "layout-parallel",
    assert: async ({ page }) => {
      await runPeAction(page);
      await expect(testId(page, "parallel-layout-data")).toHaveText(
        "from-main-layout",
      );
      await expect(testId(page, "parallel-handler-data")).toHaveText("none");
    },
  },
  {
    id: "MW1",
    contract:
      "global and route middleware set context vars and cookies readable by loaders on initial render",
    transport: "js",
    execution: "full-render",
    scope: "n/a",
    assert: async ({ page }) => {
      // Global middleware set context var and cookie
      await expect(testId(page, "layout-global-var")).toHaveText("from-global");
      await expect(testId(page, "loader-global-cookie")).toHaveText("gv");
      // Route middleware set context var and cookie
      await expect(testId(page, "layout-route-var")).toHaveText(
        "from-route-mw",
      );
      await expect(testId(page, "loader-route-cookie")).toHaveText("rv");
    },
  },
  {
    id: "I1",
    contract:
      "soft navigation triggers intercept when when() condition is true",
    transport: "js",
    execution: "full-render",
    scope: "n/a",
    url: "/prerender-intercept",
    assert: async ({ page }) => {
      await expect(testId(page, "pri-index")).toBeVisible();
      const modal = testId(page, "pri-modal");
      const detail = testId(page, "pri-detail");

      const clickAndReadSurface = async () => {
        await page.waitForTimeout(100);
        await testId(page, "pri-link-alpha").click();
        let surface: "modal" | "detail" | "pending" = "pending";
        await expect
          .poll(
            async () => {
              if (await modal.isVisible()) {
                surface = "modal";
                return surface;
              }
              if (await detail.isVisible()) {
                surface = "detail";
                return surface;
              }
              return "pending";
            },
            {
              timeout: 10000,
              message:
                "Expected prerender intercept navigation to land in modal or detail",
            },
          )
          .not.toBe("pending");
        return surface;
      };

      // The dedicated prerender-intercept suite covers the modal behavior in
      // depth. Here we allow several retries if a heavily loaded dev run falls
      // back to the full page on an attempt, then assert the semantic contract.
      let surface = await clickAndReadSurface();
      for (let attempt = 0; surface === "detail" && attempt < 5; attempt++) {
        await page.goBack();
        await expect(testId(page, "pri-index")).toBeVisible();
        await waitForHydration(page);
        await page.waitForTimeout(250);
        surface = await clickAndReadSurface();
      }

      expect(surface).toBe("modal");
      await expect(modal).toBeVisible({ timeout: 10000 });
      await expect(testId(page, "pri-modal-indicator")).toHaveText(
        "Intercepted",
      );
    },
  },
  {
    id: "I2",
    contract: "direct navigation bypasses intercept and renders full page",
    transport: "js",
    execution: "full-render",
    scope: "n/a",
    url: "/prerender-intercept/alpha",
    assert: async ({ page }) => {
      await expect(testId(page, "pri-detail")).toBeVisible();
      await expect(testId(page, "pri-modal")).not.toBeVisible();
    },
  },
  {
    id: "W1",
    contract: "when() returning false prevents intercept on soft navigation",
    transport: "js",
    execution: "full-render",
    scope: "n/a",
    url: "/",
    assert: async ({ page }) => {
      // Home page (from.pathname="/") does not match the prerender-intercept
      // when condition: from.pathname.startsWith("/prerender-intercept")
      await page.evaluate(() => {
        const a = document.createElement("a");
        a.href = "/prerender-intercept/alpha";
        a.textContent = "go";
        a.setAttribute("data-testid", "temp-nav-link");
        document.body.appendChild(a);
      });
      await testId(page, "temp-nav-link").click();
      await page.waitForURL("**/prerender-intercept/alpha");
      await waitForHydration(page);
      // when() returned false: full page renders, no modal
      await expect(testId(page, "pri-detail")).toBeVisible();
      await expect(testId(page, "pri-modal")).not.toBeVisible();
    },
  },
  {
    id: "C1",
    contract: "loader without cache() runs fresh on every request",
    transport: "js",
    execution: "full-render",
    scope: "n/a",
    url: "/cache-test/non-cached-loader",
    assert: async ({ page }) => {
      const loadedAtBefore = await readTestIdText(page, "loaded-at");
      await openJsPage(page, page.url());
      const loadedAtAfter = await readTestIdText(page, "loaded-at");
      expect(loadedAtAfter).not.toBe(loadedAtBefore);
    },
  },
  {
    id: "C2",
    contract: "loader with cache() returns cached data on subsequent request",
    transport: "js",
    execution: "full-render",
    scope: "n/a",
    url: "/cache-test/cached-loader",
    assert: async ({ page }) => {
      const loadedAtBefore = await readTestIdText(page, "loaded-at");

      await expect(async () => {
        await openJsPage(page, page.url());
        const loadedAtAfter = await readTestIdText(page, "loaded-at");
        expect(loadedAtAfter).toBe(loadedAtBefore);
      }).toPass({ timeout: 5000 });
    },
  },
  {
    id: "RC1",
    contract:
      "cached response route returns the same payload on a follow-up request",
    transport: "request",
    execution: "full-render",
    scope: "n/a",
    url: "/response-cache/cached-json",
    assert: async ({ baseUrl, request }) => {
      const body1 = await readResponseJson(
        request,
        baseUrl("/response-cache/cached-json"),
      );
      const ts1 = body1.ts;

      await expect(async () => {
        const body2 = await readResponseJson(
          request,
          baseUrl("/response-cache/cached-json"),
        );
        expect(body2.ts).toBe(ts1);
      }).toPass({ timeout: 5000 });
    },
  },
  {
    id: "RC2",
    contract:
      "uncached response route re-executes on every request and changes payload",
    transport: "request",
    execution: "full-render",
    scope: "n/a",
    url: "/response-cache/uncached-json",
    assert: async ({ baseUrl, request }) => {
      const body1 = await readResponseJson(
        request,
        baseUrl("/response-cache/uncached-json"),
      );
      const body2 = await readResponseJson(
        request,
        baseUrl("/response-cache/uncached-json"),
      );
      expect(body2.ts).toBeGreaterThan(body1.ts);
    },
  },
  {
    id: "RR1",
    contract:
      "a handler-thrown Response merges effects and follows normal response caching",
    transport: "request",
    execution: "full-render",
    scope: "n/a",
    url: "/response-cache/cached-json?throw-response=1",
    assert: async ({ baseUrl, request }) => {
      const url = baseUrl("/response-cache/cached-json?throw-response=1");
      const first = await request.get(url);
      expect(first.status()).toBe(200);
      expect(first.headers()["x-thrown-response"]).toBe("merged");
      const body1 = await first.json();
      expect(body1.source).toBe("thrown-response");

      const body2 = await (await request.get(url)).json();
      expect(body2.ts).toBe(body1.ts);
    },
  },
  {
    id: "SWR1",
    contract:
      "SWR returns stale data first, then a later request sees the background refresh",
    builds: ["prod"],
    transport: "js",
    execution: "full-render",
    scope: "n/a",
    url: "/use-cache-test/swr",
    assert: async ({ baseUrl, page }) => {
      const url = baseUrl("/use-cache-test/swr");

      const initialTs = Number(await readTestIdText(page, "use-cache-swr-ts"));
      expect(initialTs).toBeGreaterThan(0);

      // Poll for stale hit: cached timestamp unchanged but server time advanced.
      // Each openJsPage on a cold isolated dev server can take 1-3s, so allow
      // enough iterations for the 2s TTL to expire.
      await expect
        .poll(
          async () => {
            await openJsPage(page, url);
            const staleTs = Number(
              await readTestIdText(page, "use-cache-swr-ts"),
            );
            const serverTs = Number(
              await readTestIdText(page, "use-cache-swr-server-ts"),
            );
            return staleTs === initialTs && serverTs - initialTs >= 2000;
          },
          {
            timeout: 20000,
            message: "expected a stale hit after the SWR TTL expired",
          },
        )
        .toBe(true);

      // Poll for fresh value after background revalidation
      await expect
        .poll(
          async () => {
            await openJsPage(page, url);
            const freshTs = Number(
              await readTestIdText(page, "use-cache-swr-ts"),
            );
            return freshTs !== initialTs;
          },
          {
            timeout: 20000,
            message: "expected a fresh value after background revalidation",
          },
        )
        .toBe(true);
    },
  },
  {
    id: "PR1",
    contract:
      "pre-rendered content stays frozen across reloads while preserving build-time shared data",
    builds: ["prod"],
    transport: "js",
    execution: "full-render",
    scope: "in-scope-child",
    url: "/prerender-ctx/alpha",
    assert: async ({ page }) => {
      await expect(testId(page, "prerender-ctx-build")).toHaveText("true");
      await expect(testId(page, "prerender-ctx-shared")).toHaveText(
        "fetched-at-build",
      );
      await expect(testId(page, "prerender-ctx-layout-data")).toHaveText(
        "data-for-alpha",
      );
      await expect(testId(page, "prerender-ctx-sidebar-data")).toHaveText(
        "data-for-alpha",
      );

      const ts1 = await readTestIdText(page, "prerender-ctx-timestamp");
      await page.reload();
      await waitForHydration(page);
      const ts2 = await readTestIdText(page, "prerender-ctx-timestamp");
      expect(ts2).toBe(ts1);
    },
  },
  {
    id: "PT1",
    contract:
      "passthrough prerender routes fall back to live execution for unknown params",
    builds: ["prod"],
    transport: "js",
    execution: "full-render",
    scope: "in-scope-child",
    url: "/prerender-ctx/unknown-slug",
    assert: async ({ page }) => {
      await expect(testId(page, "prerender-ctx-build")).toHaveText("false");
      await expect(testId(page, "prerender-ctx-layout-data")).toHaveText(
        "data-for-unknown-slug",
      );
      await expect(testId(page, "prerender-ctx-sidebar-data")).toHaveText(
        "data-for-unknown-slug",
      );

      const ts1 = await readTestIdText(page, "prerender-ctx-timestamp");
      await page.reload();
      await waitForHydration(page);
      const ts2 = await readTestIdText(page, "prerender-ctx-timestamp");
      expect(ts2).not.toBe(ts1);
    },
  },
  // PPR commit point + capture execution model: the shell serve path commits
  // AFTER the whole middleware chain (global router.use() AND route DSL
  // middleware()), so a middleware rejection wins before a single shell byte —
  // even on a warmed route. And the background capture renders under a derived
  // context that INHERITS the request's post-middleware state instead of
  // re-running the chain: the middleware-run counter advances exactly once per
  // HTTP request, captures included, while the captured shell still carries the
  // middleware-derived ctx value (scope fidelity). Holes are render-defined
  // (loading() boundaries and pending promises under Suspense), not config.
  {
    id: "PPR1",
    contract:
      "shell serve commits after ALL middleware (401 => zero shell bytes) and capture never re-runs the chain (counter exact, mw ctx value photographed)",
    transport: "request",
    execution: "shell-capture",
    scope: "n/a",
    assert: async ({ request, baseUrl }) => {
      const authed = {
        headers: { Accept: "text/html", "x-shell-auth": "yes" },
      };
      const unauthed = { headers: { Accept: "text/html" } };
      const url = baseUrl("/shell-secure?probe=matrix-guarded");
      const readRuns = async () =>
        Number(await (await request.get(baseUrl("/shell-secure-runs"))).text());

      // Warm to HIT with authorized requests.
      await expect(async () => {
        const r = await request.get(url, authed);
        expect(r.headers()["x-rango-shell"]).toBe("HIT");
      }).toPass({ timeout: 10000 });

      // Unauthorized on the WARMED route: middleware 401, zero shell bytes.
      const denied = await request.get(url, unauthed);
      expect(denied.status()).toBe(401);
      const deniedBody = await denied.text();
      expect(deniedBody).toBe("unauthorized");
      expect(denied.headers()["x-rango-shell"]).toBeUndefined();

      // Scope fidelity: the captured prelude carries the middleware ctx value.
      const hit = await request.get(url, authed);
      const html = await hit.text();
      expect(html.slice(0, html.indexOf("</html>"))).toContain(
        "MW-SCOPE-VALUE",
      );

      // Capture never re-runs middleware: exactly one run per request.
      const before = await readRuns();
      for (let i = 0; i < 3; i++) {
        const r = await request.get(url, authed);
        expect(r.headers()["x-rango-shell"]).toBe("HIT");
      }
      await new Promise((r) => setTimeout(r, 300));
      // 3 authed requests above; the unauthorized/denied ones are separate GETs
      // counted at their own time, so only the delta window matters here.
      expect((await readRuns()) - before).toBe(3);
    },
  },
  // Serve-time guarding: every serve — MISS and HIT — runs the FULL chain (route
  // middleware + handlers + fresh loaders) via executeRender; only the shell HTML
  // is cached. So a HIT body carries BOTH the frozen shell AND freshly-rendered live
  // loader content — proving the chain executed at serve time, not just replayed a
  // cached document. (Composition is marker-gated, so a short-circuit — 401/redirect
  // — never composes a shell; the shell-cache middleware unit tests pin that half.)
  {
    id: "PPR2",
    contract:
      "serve-time guarding: a HIT still runs the full chain — the shell is frozen but the loader hole is fresh",
    transport: "request",
    execution: "shell-capture",
    scope: "n/a",
    assert: async ({ request, baseUrl }) => {
      const html = { headers: { Accept: "text/html" } };
      const url = baseUrl("/shell-cache?probe=matrix-guard");
      await expect(async () => {
        const r = await request.get(url, html);
        expect(r.headers()["x-rango-shell"]).toBe("HIT");
      }).toPass({ timeout: 10000 });
      const res = await request.get(url, html);
      expect(res.headers()["x-rango-shell"]).toBe("HIT");
      const body = await res.text();
      // Frozen shell (from ring-3 replay) AND fresh live loader output (chain ran).
      expect(body).toContain("Shell Cache Demo");
      expect(body).toContain("Live price:");
    },
  },
  // The CONSUMPTION-LANE RULE (issue #672 / #674): server-side handler
  // consumption via `await ctx.use(loader)` is the BAKED lane in every shared
  // artifact — cache(), "use cache", and the PPR shell. During capture the
  // loader EXECUTES with identity reads (cookies()/headers()) permitted
  // (mirroring the cache() purity allowance), so the capture is never refused;
  // the value freezes as a capture-time copy wherever it renders as
  // unshielded shell material. DSL segment lanes are unchanged — a loader
  // ALSO registered live-lane (loader()+loading()) still masks at capture and
  // keeps its boundary a live hole. Client-side useLoader is the live lane.
  {
    id: "PPR3",
    contract:
      "consumption-lane rule: handler ctx.use of a cookie-reading loader executes at capture (no refusal); unshielded value bakes frozen; a registered live-lane slot stays a live hole",
    transport: "request",
    execution: "shell-capture",
    scope: "layout-parallel",
    assert: async ({ request, baseUrl }) => {
      const html = { headers: { Accept: "text/html" } };
      const url = baseUrl("/shell-cache/slot-use?probe=matrix-lane");

      // No refusal: the route reaches HIT despite the handlers' cookies()
      // reads (pre-rule these tripped the identity guard -> MISS forever).
      await expect(async () => {
        const r = await request.get(url, html);
        expect(r.headers()["x-rango-shell"]).toBe("HIT");
      }).toPass({ timeout: 10000 });

      const first = await (await request.get(url, html)).text();
      const prelude = first.slice(0, first.indexOf("</html>"));
      // BAKED: layout-handler-consumed unregistered loader (capture ran
      // cookie-less -> "anon") froze into the shared prelude.
      const chip = prelude.match(/srv-chip-(\d+)-anon/);
      expect(chip).not.toBeNull();
      // Segment lane unchanged: the same-consumption slot whose loader is
      // registered live-lane still postpones (fallback frozen, hole live).
      expect(prelude).toContain("srv badge pending...");
      expect(prelude).not.toMatch(/srv-badge-\d/);

      // Frozen across HITs AND visitors — the rule's documented footgun.
      const second = await (
        await request.get(url, {
          headers: { ...html.headers, Cookie: "srv_visitor=user-a" },
        })
      ).text();
      const secondPrelude = second.slice(0, second.indexOf("</html>"));
      expect(secondPrelude).toContain(`srv-chip-${chip![1]}-anon`);
      expect(secondPrelude).not.toMatch(/srv-chip-\d+-user-a/);
    },
  },
  {
    id: "PPR4",
    contract:
      "conditional transition predicates rerun on every PPR shell HIT while route handlers replay",
    transport: "request",
    execution: "shell-capture",
    scope: "in-scope-child",
    assert: async ({ request, baseUrl }) => {
      const htmlHeaders = { headers: { Accept: "text/html" } };
      const url = baseUrl("/shell-cache/exec-matrix?probe=matrix-transition");
      await expect(async () => {
        const response = await request.get(url, htmlHeaders);
        expect(response.headers()["x-rango-shell"]).toBe("HIT");
      }).toPass({ timeout: 10000 });

      const readCounters = async () => {
        const response = await request.get(url, htmlHeaders);
        expect(response.headers()["x-rango-shell"]).toBe("HIT");
        const body = await response.text();
        const match = body.match(
          /data-testid="shell-exec-counters"[^>]*>(\{[^<]+\})</,
        );
        expect(match).toBeTruthy();
        return JSON.parse(match![1].replace(/&quot;/g, '"')) as {
          transitionWhen: number;
          path: number;
          layout: number;
          parallel: number;
        };
      };

      const first = await readCounters();
      const second = await readCounters();
      expect(second.transitionWhen).toBe(first.transitionWhen + 1);
      expect(second.path).toBe(first.path);
      expect(second.layout).toBe(first.layout);
      expect(second.parallel).toBe(first.parallel);
    },
  },
];

function registerSemanticMatrixSuite(build: BuildAxis): void {
  const mode = build === "dev" ? "dev" : "build";
  const suffix = build === "prod" ? " (production)" : "";

  test.describe(`Semantic matrix${suffix}`, () => {
    test.describe.configure({ mode: "serial" });

    const fixture = useFixture({
      root: "./e2e/test-app",
      mode,
      isolatedServer: true,
    });

    const rowsForBuild = matrixRows.filter(
      (entry) => !entry.builds || entry.builds.includes(build),
    );

    for (const row of rowsForBuild.filter(
      (entry) => entry.transport === "js",
    )) {
      test(rowTitle(row), async ({ page, request }) => {
        using _ = expectNoPageError(page);
        await openJsPage(page, fixture.url(row.url ?? "/mw-chain"));
        await row.assert({
          baseUrl: fixture.url,
          build,
          page,
          request,
        });
      });
    }

    test.describe("PE transport", () => {
      test.use({ javaScriptEnabled: false });

      for (const row of rowsForBuild.filter(
        (entry) => entry.transport === "pe",
      )) {
        test(rowTitle(row), async ({ page, request }) => {
          await openPePage(page, fixture.url("/mw-chain"));
          await row.assert({
            baseUrl: fixture.url,
            build,
            page,
            request,
          });
        });
      }
    });

    for (const row of rowsForBuild.filter(
      (entry) => entry.transport === "request",
    )) {
      test(rowTitle(row), async ({ page, request }) => {
        await row.assert({
          baseUrl: fixture.url,
          build,
          page,
          request,
        });
      });
    }
  });
}

registerSemanticMatrixSuite("dev");
registerSemanticMatrixSuite("prod");
