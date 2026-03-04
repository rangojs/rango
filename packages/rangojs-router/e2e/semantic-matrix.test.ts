import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

type BuildAxis = "dev" | "prod";
type TransportAxis = "js" | "pe";
type ExecutionAxis = "full-render" | "action-followup";
type ScopeAxis =
  | "in-scope-child"
  | "sibling-orphan"
  | "layout-parallel"
  | "n/a";

type MatrixContext = {
  page: Page;
};

type SemanticMatrixRow = {
  id: string;
  contract: string;
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
      const first = await testId(page, "loaded-at").textContent();
      await page.waitForTimeout(100);
      await openJsPage(page, page.url());
      const second = await testId(page, "loaded-at").textContent();
      expect(second).not.toBe(first);
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
      const first = await testId(page, "loaded-at").textContent();
      // Wait for async cache write (waitUntil)
      await page.waitForTimeout(500);
      await openJsPage(page, page.url());
      const second = await testId(page, "loaded-at").textContent();
      expect(second).toBe(first);
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

    for (const row of matrixRows.filter((entry) => entry.transport === "js")) {
      test(rowTitle(row), async ({ page }) => {
        using _ = expectNoPageError(page);
        await openJsPage(page, fixture.url(row.url ?? "/mw-chain"));
        await row.assert({ page });
      });
    }

    test.describe("PE transport", () => {
      test.use({ javaScriptEnabled: false });

      for (const row of matrixRows.filter(
        (entry) => entry.transport === "pe",
      )) {
        test(rowTitle(row), async ({ page }) => {
          await openPePage(page, fixture.url("/mw-chain"));
          await row.assert({ page });
        });
      }
    });
  });
}

registerSemanticMatrixSuite("dev");
registerSemanticMatrixSuite("prod");
