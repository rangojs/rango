import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { expectConsole } from "./console-guard.js";
import { waitForShellHydration } from "./shell-request.js";

/**
 * An action that writes, then throws, on a route with its own errorBoundary()
 * under a layout whose loader reads the write (a cart count). The user stays
 * on the page. The error-boundary response is the action's revalidation cut
 * at the boundary: above it, what a successful action would
 * re-run (the layout's loader); at it, the boundary. So the page shows the
 * boundary and the write together, and a link under the same layout keeps
 * the fresh count. Other tabs refresh and a fresh load read the write too.
 * An earlier action's follow-up, owed to the page while it shows the
 * boundary, holds the boundary and re-renders what is above it.
 * Fixture: action-boundary.tsx in each app, mounted at /action-boundary; both
 * apps call this from a dev and a (production) describe.
 */

export interface ActionBoundaryScenarioOptions {
  url: (pathname: string) => string;
}

const PAGE = "/action-boundary/page";

export function runActionBoundaryTests(
  options: ActionBoundaryScenarioOptions,
): void {
  /** The page under a fresh cart (cart 0). */
  async function open(context: BrowserContext, page: Page): Promise<void> {
    await context.addCookies([
      { name: "ab-key", value: randomUUID(), url: options.url("/") },
    ]);
    await show(page);
  }

  async function show(page: Page): Promise<void> {
    await page.goto(options.url(PAGE));
    await waitForShellHydration(page);
    await expect(page.getByTestId("ab-page")).toBeVisible();
  }

  /** The action writes, then throws; the call's rejection is caught. */
  async function addThenFail(page: Page): Promise<void> {
    await page.getByTestId("ab-fail").click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-ab-result",
      "error",
    );
    await expect(page.getByTestId("ab-boundary")).toBeVisible();
    await expect(page.getByTestId("ab-page")).toHaveCount(0);
  }

  test("a successful action shows its write in the layout's count", async ({
    page,
    context,
  }) => {
    await open(context, page);
    await expect(page.getByTestId("ab-cart")).toHaveText("cart:0");

    await page.getByTestId("ab-add").click();
    await expect(page.locator("html")).toHaveAttribute("data-ab-result", "1");
    await expect(page.getByTestId("ab-cart")).toHaveText("cart:1");
  });

  test("an action that throws under its route's errorBoundary() shows the boundary, and the layout's count above it shows the write", async ({
    page,
    context,
  }) => {
    expectConsole(page, { allow: [/\[Browser\] Action failed/] });
    await open(context, page);
    await expect(page.getByTestId("ab-cart")).toHaveText("cart:0");
    const otherTab = await context.newPage();
    await show(otherTab);
    await expect(otherTab.getByTestId("ab-cart")).toHaveText("cart:0");

    await addThenFail(page);
    // The write reached the server: the other tab refreshes on the
    // action's broadcast, and a fresh load reads it.
    await expect(otherTab.getByTestId("ab-cart")).toHaveText("cart:1");
    const fresh = await context.newPage();
    await show(fresh);
    await expect(fresh.getByTestId("ab-cart")).toHaveText("cart:1");

    // The boundary's response re-ran the layout's loader.
    await expect(page.getByTestId("ab-cart")).toHaveText("cart:1");
  });

  test("a link to another page under the same layout after a thrown action shows the write", async ({
    page,
    context,
  }) => {
    expectConsole(page, { allow: [/\[Browser\] Action failed/] });
    await open(context, page);
    await addThenFail(page);

    // A forward link holds the layout and its loader: the page keeps the
    // copy the boundary's response brought.
    await page.getByTestId("ab-to-other").click();
    await expect(page.getByTestId("ab-other")).toBeVisible();
    await expect(page.getByTestId("ab-cart")).toHaveText("cart:1");
  });

  test("Back to a page whose action threw under its route's errorBoundary() shows the write in the layout's count", async ({
    page,
    context,
  }) => {
    expectConsole(page, { allow: [/\[Browser\] Action failed/] });
    await open(context, page);
    await addThenFail(page);

    // The action marked the page's entry stale: Back revalidates it.
    await page.getByTestId("ab-to-other").click();
    await expect(page.getByTestId("ab-other")).toBeVisible();
    const revalidated = staleRefetch(page);
    await page.goBack();
    await expect(page).toHaveURL(options.url(PAGE));
    await (await revalidated).finished();

    await expect(page.getByTestId("ab-cart")).toHaveText("cart:1");
  });

  test("Back to a page whose action threw keeps its boundary on screen, and the revalidation refreshes the layout's count above it", async ({
    page,
    context,
  }) => {
    expectConsole(page, { allow: [/\[Browser\] Action failed/] });
    await open(context, page);
    await addThenFail(page);
    await page.getByTestId("ab-to-other").click();
    await expect(page.getByTestId("ab-other")).toBeVisible();
    // Another tab writes while the user is on /other.
    const otherTab = await context.newPage();
    await show(otherTab);
    await otherTab.getByTestId("ab-add").click();
    await expect(otherTab.getByTestId("ab-cart")).toHaveText("cart:2");
    await expect(page.getByTestId("ab-cart")).toHaveText("cart:2");

    await watchBoundary(page);
    const revalidated = staleRefetch(page);
    await page.goBack();
    await expect(page.getByTestId("ab-boundary")).toBeVisible();
    const response = await revalidated;
    await response.finished();
    await expect(page.getByTestId("ab-nav-state")).toHaveText("idle");
    await page.waitForTimeout(500);

    // Back restores the boundary the user left; its
    // revalidation holds it and refreshes what is above it.
    await expectSameBoundary(page);
    await expect(page.getByTestId("ab-cart")).toHaveText("cart:2");
    const url = new URL(response.url());
    expect(url.searchParams.get("_rsc_boundary")).toBeTruthy();

    // The page holds only what is above the boundary: a link to it
    // renders the page.
    await page.getByTestId("ab-to-page").click();
    await expect(page.getByTestId("ab-page")).toBeVisible();
    await expect(page.getByTestId("ab-boundary")).toHaveCount(0);
  });

  test("a link to the page after Back to its action's boundary shows the page, not the boundary", async ({
    page,
    context,
  }) => {
    expectConsole(page, { allow: [/\[Browser\] Action failed/] });
    await open(context, page);
    // keepClientCache(): the page's entry stays fresh, so Back restores it
    // with no revalidation.
    await page.getByTestId("ab-reject").click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-ab-result",
      "error",
    );
    await expect(page.getByTestId("ab-boundary")).toBeVisible();
    await page.getByTestId("ab-to-other").click();
    await expect(page.getByTestId("ab-other")).toBeVisible();
    let revalidations = 0;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        url.pathname.endsWith(PAGE) &&
        url.searchParams.get("_rsc_stale") === "true"
      ) {
        revalidations++;
      }
    });
    await page.goBack();
    await expect(page.getByTestId("ab-boundary")).toBeVisible();
    await page.waitForTimeout(500);
    expect(revalidations).toBe(0);

    // The restored page holds only what is above the boundary.
    await page.getByTestId("ab-to-page").click();
    await expect(page.getByTestId("ab-page")).toBeVisible();
    await expect(page.getByTestId("ab-boundary")).toHaveCount(0);
  });

  test("another tab's action refreshes the layout's count above an action's boundary and keeps the boundary on screen", async ({
    page,
    context,
  }) => {
    expectConsole(page, { allow: [/\[Browser\] Action failed/] });
    await open(context, page);
    await addThenFail(page);
    await expect(page.getByTestId("ab-boundary-tail")).toHaveText("done");
    await watchBoundary(page);

    const refreshed = staleRefetch(page);
    const otherTab = await context.newPage();
    await show(otherTab);
    await otherTab.getByTestId("ab-add").click();
    await expect(otherTab.getByTestId("ab-cart")).toHaveText("cart:2");
    const response = await refreshed;
    await response.finished();
    await expect(page.getByTestId("ab-cart")).toHaveText("cart:2");
    await expect(page.getByTestId("ab-nav-state")).toHaveText("idle");
    await page.waitForTimeout(500);

    // The cross-tab refresh holds the boundary, as the
    // follow-up does, and refreshes what is above it.
    await expectSameBoundary(page);
    const url = new URL(response.url());
    expect(url.searchParams.get("_rsc_boundary")).toBeTruthy();

    await page.getByTestId("ab-to-page").click();
    await expect(page.getByTestId("ab-page")).toBeVisible();
    await expect(page.getByTestId("ab-boundary")).toHaveCount(0);
  });

  test("a late boundary response for the page the user left keeps the useAction() of an action started on the page they moved to", async ({
    page,
    context,
  }) => {
    expectConsole(page, { allow: [/\[Browser\] Action failed/] });
    await open(context, page);

    // X (throws into the boundary after 1 s) is sent; the user moves to
    // /other and sends Y (3.5 s), still in flight when X's response lands.
    await page.getByTestId("ab-fail-late").click();
    await page.getByTestId("ab-to-other").click();
    await expect(page.getByTestId("ab-other")).toBeVisible();
    // X's exit owes /other the follow-up (R3): one stale refetch once Y,
    // the batch's last action, exits.
    const followUp = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname.endsWith("/action-boundary/other") &&
        url.searchParams.get("_rsc_stale") === "true"
      );
    });
    await page.getByTestId("ab-slow").click();
    await expect(page.getByTestId("ab-slow-state")).not.toHaveText("idle");

    // X's boundary is dropped and aborts nothing: Y's
    // useAction() reaches its result and its call resolves with it.
    await expect(page.getByTestId("ab-slow-result")).toHaveText("y-done", {
      timeout: 10_000,
    });
    await expect(page.getByTestId("ab-slow-state")).toHaveText("idle");
    await expect(page.locator("html")).toHaveAttribute(
      "data-ab-result",
      "y-done",
    );
    // X failed: the layout's useAction(X) reader records its error.
    await expect(page.getByTestId("ab-late-error")).toHaveText("error");
    await followUp;
  });

  test("an action that throws into its route's errorBoundary() reports its error to useAction() above the boundary", async ({
    page,
    context,
  }) => {
    expectConsole(page, { allow: [/\[Browser\] Action failed/] });
    await open(context, page);

    await page.getByTestId("ab-fail-late").click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-ab-result",
      "error",
    );
    await expect(page.getByTestId("ab-boundary")).toBeVisible();

    // The boundary's response still streams (its Suspense tail)
    // when it aborts the other actions; the action's own entry keeps its
    // error for the layout's reader, and counts as in flight until the
    // stream ends, as a successful action does.
    await expect(page.getByTestId("ab-nav-state")).toHaveText("loading");
    await expect(page.getByTestId("ab-late-error")).toHaveText("error", {
      timeout: 3000,
    });
    await expect(page.getByTestId("ab-nav-state")).toHaveText("idle");
  });

  /**
   * Records the boundary's node the first time it is in the DOM, and counts
   * every time that node leaves it.
   */
  async function watchBoundary(page: Page): Promise<void> {
    await page.evaluate(() => {
      const w = window as unknown as {
        __abBoundary: Element | null;
        __abBoundaryLeft: number;
      };
      w.__abBoundary = null;
      w.__abBoundaryLeft = 0;
      const note = () => {
        const shown = document.querySelector('[data-testid="ab-boundary"]');
        if (shown && !w.__abBoundary) w.__abBoundary = shown;
        if (w.__abBoundary && !w.__abBoundary.isConnected) {
          w.__abBoundaryLeft++;
        }
      };
      note();
      new MutationObserver(note).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    });
  }

  /** The boundary watchBoundary() first saw is on screen, never having left. */
  async function expectSameBoundary(page: Page): Promise<void> {
    await expect(page.getByTestId("ab-boundary")).toBeVisible();
    await expect(page.getByTestId("ab-page")).toHaveCount(0);
    expect(
      await page.evaluate(() => {
        const w = window as unknown as {
          __abBoundary: Element | null;
          __abBoundaryLeft: number;
        };
        return {
          connected: w.__abBoundary?.isConnected,
          left: w.__abBoundaryLeft,
        };
      }),
    ).toEqual({ connected: true, left: 0 });
  }

  /** The page's next stale refetch (SWR, a follow-up or a refresh). */
  function staleRefetch(page: Page) {
    return page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname.endsWith(PAGE) &&
        url.searchParams.get("_rsc_stale") === "true"
      );
    });
  }

  /**
   * W (fails after 4.5 s) is sent on the page after an earlier action X
   * (sent before the user moved) has landed unseen, so X owes the page the
   * follow-up when W, the last action, exits. Resolves with the follow-up's
   * URL once the page settled.
   */
  async function boundaryThenFollowUp(
    page: Page,
    startEarlierAction: () => Promise<void>,
  ): Promise<URL> {
    await startEarlierAction();
    const followUp = staleRefetch(page);

    // W throws into the page's errorBoundary() after X has landed: with the
    // defect its boundary is on screen for one frame only.
    await watchBoundary(page);
    await page.getByTestId("ab-fail-slow").click();
    await page.waitForFunction(
      () =>
        (window as unknown as { __abBoundary: Element | null }).__abBoundary !==
        null,
      undefined,
      { timeout: 10_000 },
    );

    // W's exit runs the follow-up; the page settles.
    const response = await followUp;
    await response.finished();
    await expect(page.getByTestId("ab-nav-state")).toHaveText("idle", {
      timeout: 10_000,
    });
    await page.waitForTimeout(1000);
    return new URL(response.url());
  }

  /**
   * The boundary W showed is on screen after the follow-up, as the same
   * node, and its Suspense tail streamed into it; the follow-up held it and
   * nothing else.
   */
  async function expectBoundaryKept(page: Page, followUp: URL): Promise<void> {
    await expectSameBoundary(page);
    await expect(page.getByTestId("ab-boundary-tail")).toHaveText("done");
    expect(followUp.searchParams.get("_rsc_segments")).toBe("");
    expect(followUp.searchParams.get("_rsc_boundary")).toBeTruthy();
  }

  test("an error boundary a later action shows stays on screen after an earlier action's follow-up", async ({
    page,
    context,
  }) => {
    expectConsole(page, { allow: [/\[Browser\] Action failed/] });
    await open(context, page);
    await page.getByTestId("ab-to-other").click();
    await expect(page.getByTestId("ab-other")).toBeVisible();

    const followUp = await boundaryThenFollowUp(page, async () => {
      // X (3.5 s, succeeds) is sent from /other; the user moves to the page
      // before it lands, so its response is not shown.
      await page.getByTestId("ab-slow").click();
      await expect(page.getByTestId("ab-slow-state")).not.toHaveText("idle");
      await page.getByTestId("ab-to-page").click();
      await expect(page.getByTestId("ab-page")).toBeVisible();
    });

    // The follow-up held W's boundary and re-rendered above it.
    await expectBoundaryKept(page, followUp);
    await expect(page.getByTestId("ab-cart")).toHaveText("cart:1");
  });

  test("a link back to the page after the follow-up held its boundary shows the page, not the boundary", async ({
    page,
    context,
  }) => {
    expectConsole(page, { allow: [/\[Browser\] Action failed/] });
    await open(context, page);
    await page.getByTestId("ab-to-other").click();
    await expect(page.getByTestId("ab-other")).toBeVisible();

    const followUp = await boundaryThenFollowUp(page, async () => {
      await page.getByTestId("ab-slow").click();
      await expect(page.getByTestId("ab-slow-state")).not.toHaveText("idle");
      await page.getByTestId("ab-to-page").click();
      await expect(page.getByTestId("ab-page")).toBeVisible();
    });
    await expectBoundaryKept(page, followUp);

    // Both links are prefetch="none": the page's history entry, not a
    // prefetch, decides what the link back holds.
    await page.getByTestId("ab-to-other").click();
    await expect(page.getByTestId("ab-other")).toBeVisible();
    await page.getByTestId("ab-to-page").click();
    await expect(page.getByTestId("ab-page")).toBeVisible();
    await expect(page.getByTestId("ab-boundary")).toHaveCount(0);
    await expect(page.getByTestId("ab-cart")).toHaveText("cart:1");
  });

  test("an error boundary a later action shows stays on screen after the follow-up an earlier action's dropped boundary owes", async ({
    page,
    context,
  }) => {
    expectConsole(page, { allow: [/\[Browser\] Action failed/] });
    await open(context, page);

    const followUp = await boundaryThenFollowUp(page, async () => {
      // X (throws into the boundary after 1 s) is sent; the user moves to
      // /other and back to the page, a new entry, before it lands.
      await page.getByTestId("ab-fail-late").click();
      await page.getByTestId("ab-to-other").click();
      await expect(page.getByTestId("ab-other")).toBeVisible();
      await page.getByTestId("ab-to-page").click();
      await expect(page.getByTestId("ab-page")).toBeVisible();
    });

    await expectBoundaryKept(page, followUp);
    // Both writes, above the boundary.
    await expect(page.getByTestId("ab-cart")).toHaveText("cart:2");
  });

  test("an earlier action's follow-up re-reads a layout loader that a later action's boundary response held", async ({
    page,
    context,
  }) => {
    expectConsole(page, { allow: [/\[Browser\] Action failed/] });
    await open(context, page);
    await page.getByTestId("ab-to-other").click();
    await expect(page.getByTestId("ab-other")).toBeVisible();
    await expect(page.getByTestId("ab-note")).toHaveText("note:0");

    const followUp = await boundaryThenFollowUp(page, async () => {
      // X (3.5 s) writes the note, which only X's revalidation re-reads; the
      // user moves to the page before it lands.
      await page.getByTestId("ab-slow-note").click();
      await page.getByTestId("ab-to-page").click();
      await expect(page.getByTestId("ab-page")).toBeVisible();
    });

    // W's boundary response skipped the note loader (its revalidate() is
    // X's only); the follow-up holds nothing above the boundary, so it
    // re-ran it.
    await expectBoundaryKept(page, followUp);
    await expect(page.getByTestId("ab-note")).toHaveText("note:1");
    await expect(page.getByTestId("ab-cart")).toHaveText("cart:1");
  });
}
