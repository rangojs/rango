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
type ExecutionAxis = "full-render" | "action-followup";
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
      await testId(page, "pri-link-alpha").click();
      await expect(testId(page, "pri-modal")).toBeVisible();
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
      const countBefore = await parseLoaderCount(page);
      await openJsPage(page, page.url());
      const countAfter = await parseLoaderCount(page);
      expect(countAfter).toBeGreaterThan(countBefore);
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
      const countBefore = await parseLoaderCount(page);

      await expect(async () => {
        await openJsPage(page, page.url());
        const countAfter = await parseLoaderCount(page);
        expect(countAfter).toBe(countBefore);
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
      const ts1 = body1.data.ts;

      await expect(async () => {
        const body2 = await readResponseJson(
          request,
          baseUrl("/response-cache/cached-json"),
        );
        expect(body2.data.ts).toBe(ts1);
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
      expect(body2.data.ts).toBeGreaterThan(body1.data.ts);
    },
  },
  {
    id: "SWR1",
    contract:
      "SWR returns stale data first, then a later request sees the background refresh",
    transport: "js",
    execution: "full-render",
    scope: "n/a",
    url: "/use-cache-test/swr",
    assert: async ({ baseUrl, page }) => {
      const url = baseUrl("/use-cache-test/swr");

      const initialTs = Number(await readTestIdText(page, "use-cache-swr-ts"));
      expect(initialTs).toBeGreaterThan(0);

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
            timeout: 10000,
            message: "expected a stale hit after the SWR TTL expired",
          },
        )
        .toBe(true);

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
            timeout: 10000,
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
];

function registerSemanticMatrixSuite(build: BuildAxis): void {
  const mode = build === "dev" ? "dev" : "build";
  const suffix = build === "prod" ? " (production)" : "";

  test.describe(`Semantic matrix${suffix}`, () => {
    const fixture = useFixture({
      root: "./e2e/test-app",
      mode,
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
