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
        await openJsPage(page, fixture.url("/mw-chain"));
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
