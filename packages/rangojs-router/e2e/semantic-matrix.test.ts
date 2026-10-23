import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { useFixture } from "./fixture";
import {
  expectNoPageError,
  expectNoReload,
  isPrefetchRequest,
  testId,
  waitForHydration,
} from "./helper";
import {
  assertPprReplayStatus,
  assertShellStatus,
} from "@rangojs/router/testing/e2e";
import {
  expectBackOntoAStalePageShowsTheWrite,
  expectConsole,
  warmShellRequestToHit,
} from "@shared/e2e";

type BuildAxis = "dev" | "prod";
type TransportAxis = "js" | "pe" | "request";
type ExecutionAxis =
  | "full-render"
  | "partial-render"
  | "action-followup"
  | "stale-revalidation"
  | "shell-capture";
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
    id: "A3",
    contract:
      "a thrown action renders its error boundary inside route middleware in JS and no-JS: the boundary reads the middleware's ctx.set and the response carries its header",
    transport: "request",
    execution: "action-followup",
    scope: "n/a",
    assert: async ({ baseUrl, page, request }) => {
      // Fixture: test-app/src/urls/action-route-mw.tsx.
      expectConsole(page, {
        allow: [/\[Browser\] Action failed: Error: action-route-mw boom/],
      });
      await page.goto(baseUrl("/action-route-mw"));
      await waitForHydration(page);
      const post = page.waitForResponse((r) => r.url().includes("_rsc_action"));
      await testId(page, "action-route-mw-throw-btn").click();
      const jsAction = await post;
      expect(jsAction.status()).toBe(500);
      expect(jsAction.headers()["x-action-route-mw"]).toBe("applied");
      await expect(testId(page, "action-route-mw-boundary-var")).toHaveText(
        "from-route-mw",
      );

      const html = await (
        await request.get(baseUrl("/action-route-mw"))
      ).text();
      const actionField = /name="(\$ACTION_ID_[^"]+)"/.exec(html)?.[1];
      expect(actionField).toBeDefined();
      const form = await request.post(baseUrl("/action-route-mw"), {
        multipart: { [actionField!]: "" },
      });
      expect(form.status()).toBe(500);
      expect(form.headers()["x-action-route-mw"]).toBe("applied");
      expect(await form.text()).toContain(
        'data-testid="action-route-mw-boundary-var">from-route-mw<',
      );
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
    id: "R2",
    contract:
      "a clientUrls() group loader's revalidate() runs on the server on the action follow-up and sees ctx.actionResult",
    transport: "js",
    execution: "action-followup",
    scope: "in-scope-child",
    url: "/client-urls-action",
    assert: async ({ page }) => {
      // revalidate(({ isAction, actionResult }) => isAction(resultAction) ?
      // actionResult?.ok === true : undefined) in client-urls-action.tsx.
      const readRuns = async (): Promise<number> =>
        Number(await readTestIdText(page, "ca-result-runs"));
      const readCount = async (): Promise<number> =>
        Number((await readTestIdText(page, "ca-loader")).replace(/\D/g, ""));
      const before = await readRuns();

      await testId(page, "ca-result-ok").click();
      await expect.poll(readRuns).toBeGreaterThan(before);
      const afterOk = await readRuns();

      // The action bumps the counter loader's value: its re-run marks the
      // fail action's commit.
      const countBefore = await readCount();
      await testId(page, "ca-result-fail").click();
      await expect.poll(readCount).toBeGreaterThan(countBefore);
      await expect(testId(page, "ca-result-runs")).toHaveText(String(afterOk));
    },
  },
  {
    id: "R3",
    contract:
      "an action whose revalidation loader throws resolves with its result; the loader throws at its read, where the nearest boundary catches it, the page around it keeps its instance, useAction reports the error, and a later good rerun recovers",
    transport: "js",
    execution: "action-followup",
    scope: "n/a",
    url: "/action-failure-server/throw",
    assert: async ({ baseUrl, build, page }) => {
      // A fresh run scopes the fixture's failure switch and run counter.
      await openJsPage(
        page,
        baseUrl(`/action-failure-server/throw?run=${crypto.randomUUID()}`),
      );
      await expect(testId(page, "af-value")).toHaveText("stock:1");
      await testId(page, "af-page").evaluate((el) =>
        el.setAttribute("data-e2e-kept", "1"),
      );

      // The loader throws once on its rerun after the action. A build
      // redacts the message.
      const reported =
        build === "prod"
          ? "An error occurred"
          : "stock service unavailable (run 2)";
      await testId(page, "af-fail").click();
      await expect(testId(page, "af-outcome")).toHaveText("resolved:failing");
      await expect(testId(page, "af-app-boundary")).toHaveText(reported);
      await expect(testId(page, "af-revalidation-error")).toHaveText(reported);
      await expect(testId(page, "af-page")).toHaveAttribute(
        "data-e2e-kept",
        "1",
      );

      // The next action reruns it without error.
      await testId(page, "af-recover").click();
      await expect(testId(page, "af-value")).toHaveText("stock:3");
      await expect(testId(page, "af-app-boundary")).toHaveCount(0);
      await expect(testId(page, "af-page")).toHaveAttribute(
        "data-e2e-kept",
        "1",
      );
    },
  },
  {
    id: "R4",
    contract:
      "a loader that throws on a click whose prefetch failed with it (the click sends its own request), or on Back onto an entry restored from the history cache, throws at its read, where the nearest boundary catches it; the layout keeps its instance",
    transport: "js",
    execution: "partial-render",
    scope: "in-scope-child",
    url: "/settled-lane-errors/",
    assert: async ({ build, page }) => {
      const reported =
        build === "prod" ? "An error occurred" : "stock service unavailable";
      await testId(page, "sle-layout").evaluate((el) =>
        el.setAttribute("data-e2e-kept", "1"),
      );
      const expectInPlace = async (): Promise<void> => {
        await expect(testId(page, "sle-app-boundary")).toHaveText(reported);
        await expect(testId(page, "sle-layout")).toHaveAttribute(
          "data-e2e-kept",
          "1",
        );
      };

      // A prefetch that finished with the loader's error is never served:
      // the click sends its own request (#1170).
      const prefetched = page.waitForResponse(
        (response) =>
          isPrefetchRequest(response.request()) &&
          new URL(response.url()).pathname === "/settled-lane-errors/fail",
      );
      await testId(page, "sle-prefetch-fail").hover();
      await (await prefetched).finished();
      const clicked = page.waitForRequest(
        (request) =>
          !isPrefetchRequest(request) &&
          new URL(request.url()).pathname === "/settled-lane-errors/fail",
      );
      await testId(page, "sle-prefetch-fail").click();
      await clicked;
      await expectInPlace();

      // Back onto it restores the entry from the history cache.
      await testId(page, "sle-link-ok").click();
      await expect(testId(page, "sle-ok")).toBeVisible();
      await page.goBack();
      await expectInPlace();
    },
  },
  {
    id: "R5",
    contract:
      "a stale revalidation (Back onto an entry an action marked stale) applies an action's revalidation defaults: a layout loader with no revalidate() and the route segment re-run, the layout above the route does not",
    transport: "js",
    execution: "stale-revalidation",
    scope: "in-scope-child",
    url: "/stale-defaults",
    assert: async ({ baseUrl, page }) => {
      await expectBackOntoAStalePageShowsTheWrite(page, baseUrl);
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
        // Cast, not an annotation: assignments happen inside the poll closure,
        // so an annotated initializer stays narrowed to "pending" for callers.
        let surface = "pending" as "modal" | "detail" | "pending";
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
    id: "I3",
    contract:
      "an action inside a modal re-runs only the intercept loaders whose revalidate() says so; the modal keeps the rest",
    transport: "js",
    execution: "action-followup",
    scope: "n/a",
    url: "/intercept-held",
    assert: async ({ page }) => {
      // The mixed modal: one loader whose revalidate() answers false, one
      // that follows the action default (fixture: urls/intercept-held.tsx).
      await testId(page, "ih-open-mixed").click();
      await expect(testId(page, "ih-modal")).toBeVisible();
      const held = await readTestIdText(page, "ih-modal-runs");
      const rerun = await readTestIdText(page, "ih-modal-rerun-runs");

      await testId(page, "ih-modal-action").click();

      await expect(testId(page, "ih-modal-rerun-runs")).not.toHaveText(rerun);
      await expect(testId(page, "ih-modal-runs")).toHaveText(held);
      await expect(testId(page, "ih-index")).toBeVisible();
    },
  },
  {
    id: "W1",
    contract: "when() returning false prevents intercept on soft navigation",
    transport: "js",
    execution: "full-render",
    scope: "n/a",
    url: "/",
    assert: async ({ build, page }) => {
      // Home page (from.url.pathname="/") does not match the prerender-intercept
      // when condition: from.url.pathname.startsWith("/prerender-intercept")
      const prefetchResponsePromise =
        build === "prod"
          ? page.waitForResponse((response) => {
              const url = new URL(response.url());
              return (
                url.pathname === "/prerender-intercept/alpha" &&
                url.searchParams.has("_rsc_partial") &&
                isPrefetchRequest(response.request())
              );
            })
          : null;
      const clickResponsePromise =
        build === "dev"
          ? page.waitForResponse((response) => {
              const url = new URL(response.url());
              return (
                url.pathname === "/prerender-intercept/alpha" &&
                url.searchParams.has("_rsc_partial") &&
                !isPrefetchRequest(response.request())
              );
            })
          : null;
      const clickPartials: string[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (
          url.pathname === "/prerender-intercept/alpha" &&
          url.searchParams.has("_rsc_partial") &&
          !isPrefetchRequest(request)
        ) {
          clickPartials.push(request.url());
        }
      });
      await page.evaluate(() => {
        const a = document.createElement("a");
        a.href = "/prerender-intercept/alpha";
        a.textContent = "go";
        a.setAttribute("data-testid", "temp-nav-link");
        document.body.appendChild(a);
      });
      const link = testId(page, "temp-nav-link");
      await using _ = await expectNoReload(page);
      if (prefetchResponsePromise) {
        await link.scrollIntoViewIfNeeded();
        const prefetchResponse = await prefetchResponsePromise;
        expect(prefetchResponse.ok()).toBe(true);
        expect(await prefetchResponse.finished()).toBeNull();
      }
      await link.click();
      if (clickResponsePromise) {
        const clickResponse = await clickResponsePromise;
        expect(clickResponse.ok()).toBe(true);
        expect(await clickResponse.finished()).toBeNull();
      }
      await page.waitForURL("**/prerender-intercept/alpha");
      await waitForHydration(page);
      // when() returned false: full page renders, no modal
      await expect(testId(page, "pri-detail")).toBeVisible();
      await expect(testId(page, "pri-modal")).not.toBeVisible();
      if (build === "prod") expect(clickPartials).toHaveLength(0);
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
  // middleware-derived ctx value (scope fidelity). Holes are live loaders'
  // boundaries (loading() or an inline Suspense); handler output is baked.
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
  // Serve-time guarding: every serve — MISS and HIT — runs the FULL middleware
  // chain and fresh loaders via executeRender; a HIT replays the handler layer
  // from the shell's doc record and runs no handler. So a HIT body carries BOTH
  // the frozen shell AND freshly-rendered live loader content — proving the
  // chain executed at serve time, not just replayed a cached document.
  // (Composition is marker-gated, so a short-circuit — 401/redirect — never
  // composes a shell; the serve-path unit tests pin that half.)
  {
    id: "PPR2",
    contract:
      "serve-time guarding: a HIT runs the full middleware chain and fresh loaders; no handler runs — the shell is frozen, the loader hole is fresh",
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
  // Handler consumption (issue #672 / #674): `await ctx.use(loader)` in a
  // handler is handler output, baked into every shared artifact — cache(),
  // "use cache", and the PPR shell — and replayed on every HIT. The loader
  // executes at capture; an identity read (cookies()/headers()) in it refuses
  // the PPR capture (the capturing request's value would reach every visitor).
  // A loader ALSO registered live-lane (loader() without ssr: false; the
  // slot's loading() is its boundary) keeps that boundary a live hole, and a
  // client useLoader read inside it is the live lane.
  {
    id: "PPR3",
    contract:
      "handler ctx.use of a loader bakes (frozen across HITs); an identity read in it refuses the capture; the live-lane slot's useLoader read stays fresh",
    transport: "request",
    execution: "shell-capture",
    scope: "layout-parallel",
    assert: async ({ request, baseUrl }) => {
      const html = { headers: { Accept: "text/html" } };
      const url = baseUrl("/shell-cache/slot-use?probe=matrix-lane");

      await expect(async () => {
        const r = await request.get(url, html);
        expect(r.headers()["x-rango-shell"]).toBe("HIT");
      }).toPass({ timeout: 10000 });

      const first = await (await request.get(url, html)).text();
      const prelude = first.slice(0, first.indexOf("</html>"));
      // BAKED: the layout handler's awaited loader value froze into the
      // shared prelude.
      const chip = prelude.match(/srv-chip-(\d+)/);
      expect(chip).not.toBeNull();
      // The registered live-lane slot still postpones (fallback frozen).
      expect(prelude).toContain("srv badge pending...");
      expect(prelude).not.toMatch(/srv-badge-\d/);
      const live = (h: string) =>
        Number(
          h.match(/data-testid="shell-srv-badge-live">srv-badge-(\d+)</)?.[1],
        );

      const second = await (await request.get(url, html)).text();
      const secondPrelude = second.slice(0, second.indexOf("</html>"));
      expect(secondPrelude).toContain(`srv-chip-${chip![1]}`);
      expect(live(second)).toBeGreaterThan(live(first));

      // An identity read in a handler-awaited loader refuses the capture:
      // wait for the capture's own outcome (the test-app's debugShellCapture
      // sink), not a timing gap, then confirm the page is still per request.
      const target = `/shell-cache/identity-use?probe=matrix-lane-${Date.now().toString(36)}`;
      const miss = await request.get(baseUrl(target), html);
      expect(miss.headers()["x-rango-shell"]).toBe("MISS");
      const outcomes = async (): Promise<string[]> => {
        const res = await request.get(
          baseUrl(
            `/shell-cache/__capture-events?path=${encodeURIComponent(target)}`,
          ),
        );
        const { events } = (await res.json()) as {
          events: Array<{ outcome: string }>;
        };
        return events.map((event) => event.outcome);
      };
      await expect.poll(outcomes, { timeout: 20_000 }).toContain("refused");
      expect(await outcomes()).not.toContain("stored");
      const after = await request.get(baseUrl(target), html);
      expect(after.headers()["x-rango-shell"]).toBe("MISS");
    },
  },
  {
    id: "PPR4",
    contract:
      "transition({ when }) never runs on the server: a PPR shell HIT carries the predicate as a client reference while route handlers replay",
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
        // The browser decides: the payload carries the "use client" export
        // (Flight import row), not a server decision.
        expect(body).toContain("shellExecWhen");
        const match = body.match(
          /data-testid="shell-exec-counters"[^>]*>(\{[^<]+\})</,
        );
        expect(match).toBeTruthy();
        return JSON.parse(match![1].replace(/&quot;/g, '"')) as {
          path: number;
          layout: number;
          parallel: number;
        };
      };

      const first = await readCounters();
      const second = await readCounters();
      expect(second.path).toBe(first.path);
      expect(second.layout).toBe(first.layout);
      expect(second.parallel).toBe(first.parallel);
    },
  },
  {
    id: "PPR5",
    contract:
      "a cold partial request schedules an eligibility-checked navigation snapshot for later prefetch replay",
    transport: "request",
    execution: "partial-render",
    scope: "in-scope-child",
    assert: async ({ build, page, request, baseUrl }) => {
      const probe = `matrix-cold-partial-${build}-${crypto.randomUUID()}`;
      const targetPath = `/shell-cache/slot-hole?probe=${probe}`;
      await openJsPage(page, baseUrl("/"));

      const firstResponsePromise = page.waitForResponse((response) => {
        const responseUrl = new URL(response.url());
        return (
          responseUrl.pathname === "/shell-cache/slot-hole" &&
          responseUrl.searchParams.get("probe") === probe &&
          responseUrl.searchParams.has("_rsc_partial")
        );
      });
      const clickPartials: string[] = [];
      page.on("request", (request) => {
        const responseUrl = new URL(request.url());
        if (
          responseUrl.pathname === "/shell-cache/slot-hole" &&
          responseUrl.searchParams.get("probe") === probe &&
          responseUrl.searchParams.has("_rsc_partial") &&
          !isPrefetchRequest(request)
        ) {
          clickPartials.push(request.url());
        }
      });
      await page.evaluate((href) => {
        const link = document.createElement("a");
        link.href = href;
        link.dataset.testid = "matrix-cold-partial-link";
        link.textContent = "Cold partial";
        document.body.append(link);
      }, baseUrl(targetPath));
      const link = testId(page, "matrix-cold-partial-link");
      await using _ = await expectNoReload(page);
      let firstResponse;
      if (build === "prod") {
        await link.scrollIntoViewIfNeeded();
        firstResponse = await firstResponsePromise;
        expect(isPrefetchRequest(firstResponse.request())).toBe(true);
        expect(firstResponse.ok()).toBe(true);
        expect(await firstResponse.finished()).toBeNull();
        await link.click();
      } else {
        await link.click();
        firstResponse = await firstResponsePromise;
        expect(isPrefetchRequest(firstResponse.request())).toBe(false);
      }
      await page.waitForURL((url) => url.href === baseUrl(targetPath));
      await expect(testId(page, "shell-slot-home")).toBeVisible();
      if (build === "prod") expect(clickPartials).toHaveLength(0);
      assertPprReplayStatus(
        { headers: new Headers(firstResponse.headers()) },
        { outcome: "BYPASS", reason: "no-entry" },
      );

      const partialUrl = firstResponse.url();
      await expect(async () => {
        const replay = await request.get(partialUrl, {
          headers: {
            "X-RSC-Router-Client-Path": baseUrl("/"),
            "X-Rango-Prefetch": "1",
          },
        });
        assertPprReplayStatus(
          { headers: new Headers(replay.headers()) },
          { outcome: "HIT", freshness: "fresh" },
        );
      }).toPass({ timeout: 10000 });

      const documentResponse = await request.get(baseUrl(targetPath), {
        headers: { Accept: "text/html" },
      });
      assertShellStatus(
        { headers: new Headers(documentResponse.headers()) },
        "MISS",
      );
    },
  },
  // Explicit-tier-first replay composition (the storefront shape: ppr routes
  // under an ancestor cache() scope). The consumer's tier is ALWAYS consulted
  // first and serves under its own key/ttl/swr semantics — reported as
  // `explicit-cache-hit`, never a false replay HIT. Only a true miss of that
  // tier lets the shell snapshot's canonical doc segment record supply the
  // match (replay HIT). Opt-outs stay absolute: cache(false)/condition()
  // false bypass as `cache-disabled` before any shell read (pinned in
  // rsc-rendering-shell-ppr + cache-lookup-shell-replay-fallback units).
  {
    id: "PPR6",
    contract:
      "explicit-tier-first replay: a route-derived cache() hit reports explicit-cache-hit under its own semantics; only its miss lets the seeded doc record replay (HIT)",
    transport: "request",
    execution: "partial-render",
    scope: "in-scope-child",
    assert: async ({ request, baseUrl }) => {
      const htmlHeaders = { headers: { Accept: "text/html" } };
      const partialHeaders = {
        headers: { "X-RSC-Router-Client-Path": baseUrl("/") },
      };
      const warmShell = async (url: string) => {
        await expect(async () => {
          const r = await request.get(url, htmlHeaders);
          expect(r.headers()["x-rango-shell"]).toBe("HIT");
        }).toPass({ timeout: 10000 });
      };

      // 1. Explicit tier warmed by a fresh partial render (shell cold:
      //    bounded no-entry bypass; the render writes the ring-3 entry under
      //    the consumer's ttl).
      const probe = `matrix-scoped-${crypto.randomUUID()}`;
      const url = baseUrl(`/shell-cache/scoped?probe=${probe}`);
      const partialUrl = `${url}&_rsc_partial=true&_rsc_segments=`;
      const cold = await request.get(partialUrl, partialHeaders);
      assertPprReplayStatus(
        { headers: new Headers(cold.headers()) },
        { outcome: "BYPASS", reason: "no-entry" },
      );

      // 2. Shell captured; within the explicit ttl the consumer's tier stays
      //    authoritative — never reported as a replay HIT.
      await warmShell(url);
      const warm = await request.get(partialUrl, partialHeaders);
      assertPprReplayStatus(
        { headers: new Headers(warm.headers()) },
        { outcome: "BYPASS", reason: "explicit-cache-hit" },
      );

      // 3. A fresh probe (explicit partial tier cold, shell captured) is
      //    supplied by the seeded doc record — the replay HIT that used to be
      //    structurally impossible under an ancestor cache() scope.
      const probe2 = `matrix-scoped-cold-${crypto.randomUUID()}`;
      const url2 = baseUrl(`/shell-cache/scoped?probe=${probe2}`);
      await warmShell(url2);
      const replay = await request.get(
        `${url2}&_rsc_partial=true&_rsc_segments=`,
        partialHeaders,
      );
      assertPprReplayStatus(
        { headers: new Headers(replay.headers()) },
        { outcome: "HIT", freshness: "fresh" },
      );
    },
  },
  // throw rewrite() (docs/internal/execution-model.md, "Rewrite"). Fixture:
  // test-app/src/urls/rewrite.tsx; the rw-lock cookie turns the lock on.
  {
    id: "RW1",
    contract:
      "a global rewrite re-dispatches as the target: the target's pattern guard runs, pass-one ctx.set and cookies are kept, the target's chain runs and the original's never",
    transport: "request",
    execution: "full-render",
    scope: "n/a",
    assert: async ({ baseUrl, request }) => {
      const guarded = await request.get(baseUrl("/rw/global-to-guarded"));
      expect(guarded.status()).toBe(401);
      const allowed = await request.get(baseUrl("/rw/global-to-guarded"), {
        headers: { cookie: "rw-auth=1" },
      });
      expect(allowed.status()).toBe(200);
      expect(await allowed.text()).toContain("Guarded page");

      const locked = await request.get(baseUrl("/rw/shop"), {
        headers: { cookie: "rw-lock=on" },
      });
      expect(locked.status()).toBe(503);
      expect(locked.headers()["x-rango-rewrite"]).toBe("/rw/maintenance");
      // The target's route middleware ran (Retry-After) and the original's
      // never did (its post-next header).
      expect(locked.headers()["retry-after"]).toBe("600");
      expect(locked.headers()["x-rw-shop-post"]).toBeUndefined();
      expect(
        locked
          .headersArray()
          .some(
            (h) =>
              h.name.toLowerCase() === "set-cookie" &&
              h.value.startsWith("rw-pass-one=kept"),
          ),
      ).toBe(true);
      const html = await locked.text();
      expect(html).toContain('data-testid="rw-reason">deploy<');
      expect(html).toContain('data-testid="rw-from">/rw/shop<');
      expect(html).toContain('data-testid="rw-target-runs">1<');
    },
  },
  {
    id: "RW2",
    contract:
      "a route-middleware rewrite unwinds: no code after next() of the rewriting pass runs, the target's chain runs once; a rewrite after next() ran the route is an error",
    transport: "request",
    execution: "full-render",
    scope: "n/a",
    assert: async ({ baseUrl, request }) => {
      const response = await request.get(baseUrl("/rw/route-to-maintenance"));
      expect(response.status()).toBe(503);
      expect(response.headers()["x-rango-rewrite"]).toBe("/rw/maintenance");
      expect(response.headers()["x-rw-route-post"]).toBeUndefined();
      // Global middleware: once per pass; its post-next only on the target's.
      expect(response.headers()["x-rw-post"]).toBe("/rw/maintenance");
      const html = await response.text();
      expect(html).toContain('data-testid="rw-runs">2<');
      expect(html).toContain('data-testid="rw-count">1<');
      expect(html).toContain('data-testid="rw-target-runs">1<');
      expect(html).not.toContain("never rendered");

      const late = await request.get(baseUrl("/rw/after"));
      expect(late.status()).toBe(500);
      expect(late.headers()["x-rango-rewrite"]).toBeUndefined();
    },
  },
  // /rw/global/:id matches no route: global middleware rewrites every method
  // to /rw/items/:id.
  {
    id: "RW3",
    contract:
      "a global-middleware rewrite of a mutation moves it to the target before the action runs: the target's global middleware, the action once, the target's route middleware and render, in JS and no-JS; rewrite().disallowMutations() makes it an error before the action runs, and a lock's Response for mutations works in JS and no-JS",
    transport: "request",
    execution: "action-followup",
    scope: "n/a",
    assert: async ({ baseUrl, page, request }) => {
      expectConsole(page, {
        allow: [/Unhandled error caught: Error: Connection closed/],
      });
      const key = crypto.randomUUID();
      await page
        .context()
        .addCookies([{ name: "rw-key", value: key, url: baseUrl("/") }]);
      await page.goto(baseUrl("/rw/global/20"));
      await waitForHydration(page);
      await expect(testId(page, "rw-item-saves")).toHaveText("0");
      const moved = page.waitForResponse(
        (r) =>
          r.request().method() === "POST" && r.url().includes("/rw/global/20"),
      );
      await testId(page, "rw-item-save").click();
      const jsMoved = await moved;
      expect(jsMoved.status()).toBe(200);
      expect(jsMoved.headers()["x-rango-rewrite"]).toBe("/rw/items/20");
      await expect(testId(page, "rw-item-saves")).toHaveText("1");
      await expect(testId(page, "rw-item-guard")).toHaveText("target");
      await expect(testId(page, "rw-runs")).toHaveText("2");

      const itemHtml = await (
        await request.get(baseUrl("/rw/global/20"), {
          headers: { cookie: `rw-key=${key}` },
        })
      ).text();
      const actionField = /name="(\$ACTION_ID_[^"]+)"/.exec(itemHtml)?.[1];
      expect(actionField).toBeDefined();
      const formMoved = await request.post(baseUrl("/rw/global/20"), {
        headers: { cookie: `rw-key=${key}` },
        multipart: { [actionField!]: "" },
      });
      expect(formMoved.status()).toBe(200);
      expect(formMoved.headers()["x-rango-rewrite"]).toBe("/rw/items/20");
      const rerendered = await formMoved.text();
      expect(rerendered).toContain('data-testid="rw-item-saves">2<');
      expect(rerendered).toContain('data-testid="rw-item-guard">target<');
      expect(rerendered).toContain('data-testid="rw-runs">2<');

      // The same rewrite with disallowMutations(): refused, the action never runs.
      const formRefused = await request.post(baseUrl("/rw/global/20"), {
        headers: { cookie: `rw-key=${key}; rw-lock=strict` },
        multipart: { [actionField!]: "" },
      });
      expect(formRefused.status()).toBe(500);
      const after = await (
        await request.get(baseUrl("/rw/global/20"), {
          headers: { cookie: `rw-key=${key}` },
        })
      ).text();
      expect(after).toContain('data-testid="rw-item-saves">2<');

      await page.goto(baseUrl("/rw/shop"));
      await waitForHydration(page);
      await page
        .context()
        .addCookies([{ name: "rw-lock", value: "on", url: baseUrl("/") }]);
      const post = page.waitForResponse(
        (r) => r.request().method() === "POST" && r.url().includes("/rw/shop"),
      );
      await testId(page, "rw-save").click();
      const jsAction = await post;
      expect(jsAction.status()).toBe(503);
      expect(await jsAction.text()).toBe("Maintenance");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        /Internal Server Error|Connection Error/,
      );

      // A no-JS form post (pe-render) under the same lock.
      const form = await request.post(baseUrl("/rw/shop"), {
        form: { note: "x" },
        headers: { cookie: "rw-lock=on" },
      });
      expect(form.status()).toBe(503);
      expect(await form.text()).toBe("Maintenance");

      // A lock that rewrites with disallowMutations(): an error.
      const jsRejected = await request.post(
        baseUrl("/rw/shop?_rsc_action=rw%23save"),
        {
          headers: { cookie: "rw-lock=strict", "rsc-action": "rw#save" },
          data: "[]",
        },
      );
      expect(jsRejected.status()).toBe(500);
      const formRejected = await request.post(baseUrl("/rw/shop"), {
        headers: { cookie: "rw-lock=strict" },
        form: { note: "x" },
      });
      expect(formRejected.status()).toBe(500);
      await expect
        .poll(async () => {
          const log = (await (
            await request.get(baseUrl("/__test/last-error"))
          ).json()) as Array<{ phase: string; message: string }> | null;
          return (log ?? []).filter(
            (entry) =>
              entry.phase === "routing" &&
              entry.message.includes(
                "refused a mutation: .disallowMutations() was set",
              ),
          ).length;
        })
        .toBeGreaterThanOrEqual(2);
    },
  },
  {
    id: "RW4",
    contract:
      "a rewrite loop past the hop limit, or to the URL the request is on, answers 508 and reports RewriteLoopError",
    transport: "request",
    execution: "full-render",
    scope: "n/a",
    assert: async ({ baseUrl, request }) => {
      for (const [path, trail] of [
        ["/rw/loop-a", "/rw/loop-a -> /rw/loop-b -> /rw/loop-a"],
        ["/rw/self", "/rw/self -> /rw/self"],
      ] as const) {
        const response = await request.get(baseUrl(path));
        expect(response.status()).toBe(508);
        expect(response.headers()["x-rango-rewrite"]).toBeUndefined();
        await expect
          .poll(async () => {
            const log = (await (
              await request.get(baseUrl("/__test/last-error"))
            ).json()) as Array<{ phase: string; message: string }> | null;
            return (log ?? []).some(
              (entry) =>
                entry.phase === "routing" &&
                entry.message.includes(`Infinite rewrite loop: ${trail}`),
            );
          })
          .toBe(true);
      }
    },
  },
  {
    id: "RW5",
    contract:
      "a route-middleware rewrite of a mutation re-renders the target after the action ran: the action runs once, the target's global and route middleware run, in JS and no-JS",
    transport: "request",
    execution: "action-followup",
    scope: "n/a",
    assert: async ({ baseUrl, page, request }) => {
      const key = crypto.randomUUID();
      await page
        .context()
        .addCookies([{ name: "rw-key", value: key, url: baseUrl("/") }]);
      await page.goto(baseUrl("/rw/public/5"));
      await waitForHydration(page);
      await expect(testId(page, "rw-item-saves")).toHaveText("0");
      const post = page.waitForResponse(
        (r) =>
          r.request().method() === "POST" && r.url().includes("/rw/public/5"),
      );
      await testId(page, "rw-item-save").click();
      const jsAction = await post;
      expect(jsAction.status()).toBe(200);
      expect(jsAction.headers()["x-rango-rewrite"]).toBe("/rw/items/5");
      await expect(testId(page, "rw-item-saves")).toHaveText("1");
      await expect(testId(page, "rw-item-guard")).toHaveText("target");
      await expect(testId(page, "rw-runs")).toHaveText("2");

      // A no-JS form post: the action id the server-rendered form carries.
      const html = await (
        await request.get(baseUrl("/rw/public/5"), {
          headers: { cookie: `rw-key=${key}` },
        })
      ).text();
      const actionField = /name="(\$ACTION_ID_[^"]+)"/.exec(html)?.[1];
      expect(actionField).toBeDefined();
      const form = await request.post(baseUrl("/rw/public/5"), {
        headers: { cookie: `rw-key=${key}` },
        multipart: { [actionField!]: "" },
      });
      expect(form.status()).toBe(200);
      expect(form.headers()["x-rango-rewrite"]).toBe("/rw/items/5");
      const rerendered = await form.text();
      expect(rerendered).toContain('data-testid="rw-item-saves">2<');
      expect(rerendered).toContain('data-testid="rw-item-guard">target<');
      expect(rerendered).toContain('data-testid="rw-runs">2<');
    },
  },
  // A URL's shared PPR shell is read and written only by requests on that
  // URL (#1146). /rw/promo/:id rewrites to the ppr /rw/ppr/:id with no
  // .shell(); /rw/summer/:id with .shell("visitor").
  {
    id: "RW6",
    contract:
      "a rewritten request never reads a shell keyed by another URL: it renders live at the visitor's location, the target's shell warm or not",
    transport: "request",
    execution: "full-render",
    scope: "n/a",
    assert: async ({ baseUrl, request }) => {
      const id = `rw5-${crypto.randomUUID().slice(0, 8)}`;
      await warmShellRequestToHit(request, baseUrl(`/rw/ppr/${id}`));
      const rewritten = await request.get(baseUrl(`/rw/promo/${id}`), {
        headers: { Accept: "text/html" },
      });
      expect(rewritten.headers()["x-rango-rewrite"]).toBe(`/rw/ppr/${id}`);
      expect(rewritten.headers()["x-rango-shell"]).toBeUndefined();
      const html = await rewritten.text();
      expect(html).toContain(
        `data-testid="rw-client-location">/rw/promo/${id}<`,
      );
      expect(html).toContain(`data-testid="rw-ppr-from">/rw/promo/${id}<`);
    },
  },
  {
    id: "RW7",
    contract:
      "a rewritten request never captures the target's shared shell: only a request on the target's URL does, so nothing its first pass set is baked in",
    transport: "request",
    execution: "shell-capture",
    scope: "n/a",
    assert: async ({ baseUrl, request }) => {
      const id = `rw6-${crypto.randomUUID().slice(0, 8)}`;
      for (let visit = 0; visit < 2; visit++) {
        const rewritten = await request.get(baseUrl(`/rw/promo/${id}`), {
          headers: { Accept: "text/html" },
        });
        expect(rewritten.headers()["x-rango-shell"]).toBeUndefined();
      }
      const direct = await request.get(baseUrl(`/rw/ppr/${id}`), {
        headers: { Accept: "text/html" },
      });
      expect(direct.headers()["x-rango-shell"]).toBe("MISS");
      await warmShellRequestToHit(request, baseUrl(`/rw/ppr/${id}`));
      const hit = await request.get(baseUrl(`/rw/ppr/${id}`), {
        headers: { Accept: "text/html" },
      });
      const html = await hit.text();
      expect(html).toContain('data-testid="rw-ppr-public">none<');
      expect(html).not.toContain(`/rw/promo/${id}`);
    },
  },
  {
    id: "RW8",
    contract:
      "rewrite().shell(\"visitor\") keys and captures a shell per visitor URL, rendered at the visitor's location; the target's own shell stays its own",
    transport: "request",
    execution: "shell-capture",
    scope: "n/a",
    assert: async ({ baseUrl, request }) => {
      const id = `rw7-${crypto.randomUUID().slice(0, 8)}`;
      await warmShellRequestToHit(request, baseUrl(`/rw/summer/${id}`));
      const hit = await request.get(baseUrl(`/rw/summer/${id}`), {
        headers: { Accept: "text/html" },
      });
      expect(hit.headers()["x-rango-shell"]).toBe("HIT");
      const html = await hit.text();
      expect(html).toContain(
        `data-testid="rw-client-location">/rw/summer/${id}<`,
      );
      expect(html).toContain(`data-testid="rw-ppr-public">/rw/summer/${id}<`);
      expect(html).toContain(`data-testid="rw-ppr-from">/rw/summer/${id}<`);
      const direct = await request.get(baseUrl(`/rw/ppr/${id}`), {
        headers: { Accept: "text/html" },
      });
      expect(direct.headers()["x-rango-shell"]).toBe("MISS");
    },
  },
  {
    id: "RW9",
    contract:
      "a thrown action on a page route middleware rewrote renders the target's error boundary inside the target's route middleware, in JS and no-JS",
    transport: "request",
    execution: "action-followup",
    scope: "n/a",
    assert: async ({ baseUrl, request }) => {
      // The item page renders the save form, then the failing one.
      const html = await (await request.get(baseUrl("/rw/public/9"))).text();
      const failId = [...html.matchAll(/name="\$ACTION_ID_([^"]+)"/g)][1]?.[1];
      expect(failId).toBeDefined();

      const jsAction = await request.post(
        baseUrl(`/rw/public/9?_rsc_action=${encodeURIComponent(failId!)}`),
        { headers: { "rsc-action": failId! }, data: "[]" },
      );
      expect(jsAction.status()).toBe(500);
      expect(jsAction.headers()["x-rango-rewrite"]).toBe("/rw/items/9");
      const flight = await jsAction.text();
      expect(flight).toContain(
        '"data-testid":"rw-item-boundary-guard","children":"target"',
      );
      expect(flight).not.toContain("rw-public-boundary");

      const form = await request.post(baseUrl("/rw/public/9"), {
        multipart: { [`$ACTION_ID_${failId}`]: "" },
      });
      expect(form.status()).toBe(500);
      expect(form.headers()["x-rango-rewrite"]).toBe("/rw/items/9");
      const document = await form.text();
      expect(document).toContain(
        'data-testid="rw-item-boundary-guard">target<',
      );
      expect(document).not.toContain("rw-public-boundary");
    },
  },
  // Requests from a rewritten page (#1144, #1145): /rw/catalog/:slug
  // rewrites to /rw/items/:id, whose loader re-runs only for another id.
  {
    id: "RW10",
    contract:
      "a navigation or action from a page middleware rewrote diffs against the route that rendered it (the payload's rewriteTarget, sent back as _rsc_rt): revalidate() sees the target's params, so a param-scoped loader holds",
    transport: "request",
    execution: "partial-render",
    scope: "n/a",
    assert: async ({ baseUrl, page }) => {
      await page
        .context()
        .addCookies([
          { name: "rw-key", value: crypto.randomUUID(), url: baseUrl("/") },
        ]);
      // The first request for ?sort=b: a production viewport prefetch, or
      // the click's own navigation.
      const navigation = page.waitForRequest((r) =>
        r.url().includes("/rw/catalog/9?sort=b&_rsc_partial"),
      );
      await page.goto(baseUrl("/rw/catalog/9?sort=a"));
      await waitForHydration(page);
      await expect(testId(page, "rw-item-loads")).toHaveText("1");
      await testId(page, "rw-item-sort").click();
      expect(
        new URL((await navigation).url()).searchParams.get("_rsc_rt"),
      ).toBe("/rw/items/9?sort=a");
      await expect(testId(page, "rw-client-location")).toHaveText(
        "/rw/catalog/9?sort=b",
      );
      await expect(testId(page, "rw-item-renders")).toHaveText("2");
      await expect(testId(page, "rw-item-loads")).toHaveText("1");
      const post = page.waitForRequest(
        (r) => r.method() === "POST" && r.url().includes("/rw/catalog/9"),
      );
      await testId(page, "rw-item-save").click();
      expect(new URL((await post).url()).searchParams.get("_rsc_rt")).toBe(
        "/rw/items/9?sort=b",
      );
      await expect(testId(page, "rw-item-saves")).toHaveText("1");
      await expect(testId(page, "rw-item-loads")).toHaveText("1");
    },
  },
  // /rw/get-only/:id rewrites to /rw/items/:id for GETs only (#1145).
  {
    id: "RW11",
    contract:
      "route middleware sees the render after an action as the page's GET: a rewrite it makes only for GETs re-renders the target, the action runs once, in JS and no-JS",
    transport: "request",
    execution: "action-followup",
    scope: "n/a",
    assert: async ({ baseUrl, page, request }) => {
      const key = crypto.randomUUID();
      await page
        .context()
        .addCookies([{ name: "rw-key", value: key, url: baseUrl("/") }]);
      await page.goto(baseUrl("/rw/get-only/14"));
      await waitForHydration(page);
      const post = page.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          r.url().includes("/rw/get-only/14"),
      );
      await testId(page, "rw-item-save").click();
      const jsAction = await post;
      expect(jsAction.status()).toBe(200);
      expect(jsAction.headers()["x-rango-rewrite"]).toBe("/rw/items/14");
      await expect(testId(page, "rw-item-saves")).toHaveText("1");
      await expect(testId(page, "rw-item-guard")).toHaveText("target");

      const html = await (
        await request.get(baseUrl("/rw/get-only/14"), {
          headers: { cookie: `rw-key=${key}` },
        })
      ).text();
      const actionField = /name="(\$ACTION_ID_[^"]+)"/.exec(html)?.[1];
      expect(actionField).toBeDefined();
      const form = await request.post(baseUrl("/rw/get-only/14"), {
        headers: { cookie: `rw-key=${key}` },
        multipart: { [actionField!]: "" },
      });
      expect(form.status()).toBe(200);
      expect(form.headers()["x-rango-rewrite"]).toBe("/rw/items/14");
      const rerendered = await form.text();
      expect(rerendered).toContain('data-testid="rw-item-saves">2<');
      expect(rerendered).toContain('data-testid="rw-item-guard">target<');
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
