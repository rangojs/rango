import { expect, test, type Page, type Request } from "@playwright/test";
import { isPrefetchRequest } from "@rangojs/router/testing/e2e";
import {
  readState,
  readTexts,
  recordTexts,
  sameElement,
  stateEpochOf,
} from "@shared/e2e";
import { useFixture, type Fixture } from "./fixture";
import { waitForHydration } from "./helper";

function isInvalidationTarget(request: Request): boolean {
  const url = new URL(request.url());
  return (
    isPrefetchRequest(request) &&
    url.pathname === "/__prefetch-scope/target" &&
    url.searchParams.get("invalidation") === "1"
  );
}

/** A navigation request (not a prefetch) for the invalidation target. */
function isInvalidationTargetNavigation(request: Request): boolean {
  const url = new URL(request.url());
  return (
    !isPrefetchRequest(request) &&
    url.pathname === "/__prefetch-scope/target" &&
    url.searchParams.get("invalidation") === "1" &&
    url.searchParams.has("_rsc_partial")
  );
}

/**
 * Clicks the page's +1 button and returns the server counter it wrote (the
 * button shows `Count: 3` once its action settled; the page starts at 0).
 */
async function incrementCounter(page: Page): Promise<number> {
  const counter = page.getByTestId("counter-value");
  await page.getByTestId("counter-increment").click();
  await expect(counter).not.toHaveText("Count: 0");
  return Number(/-?\d+/.exec((await counter.textContent()) ?? "")![0]);
}

function runDelegatedPrefetchScopeSpec(f: Fixture): void {
  test("plain-anchor prefetch stays within the router URL namespace", async ({
    page,
  }) => {
    const prefetches: string[] = [];
    page.on("request", (request) => {
      if (isPrefetchRequest(request)) prefetches.push(request.url());
    });

    await page.goto(f.url("/__prefetch-scope"));
    await waitForHydration(page);
    await page.getByTestId("prefetch-hash-only").scrollIntoViewIfNeeded();

    await expect
      .poll(() =>
        prefetches.some(
          (url) => new URL(url).pathname === "/__prefetch-scope/target",
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        prefetches.some(
          (url) => new URL(url).pathname === "/__prefetch-scope/promo/50%off",
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        prefetches.some(
          (url) => new URL(url).pathname === "/__prefetch-scope/target.js",
        ),
      )
      .toBe(true);
    await page.waitForTimeout(500);
    expect(
      prefetches.some(
        (url) => new URL(url).pathname === "/__prefetch-scope/files/report.pdf",
      ),
    ).toBe(false);
    expect(prefetches.some((url) => new URL(url).pathname === "/about")).toBe(
      false,
    );
    expect(
      prefetches.some((url) => new URL(url).pathname === "/__prefetch-scope"),
    ).toBe(false);
    expect(
      prefetches.some(
        (url) => new URL(url).pathname === "/__prefetch-scope/logout",
      ),
    ).toBe(false);
    expect(
      prefetches.some(
        (url) => new URL(url).pathname === "/__prefetch-scope/svg-target",
      ),
    ).toBe(false);
    expect(
      prefetches.some(
        (url) =>
          new URL(url).pathname.toLowerCase() === "/__prefetch-scope%2fadmin",
      ),
    ).toBe(false);
    expect(
      prefetches.some(
        (url) => new URL(url).searchParams.get("container-scope") === "none",
      ),
    ).toBe(false);

    const realmIdentity = await page.evaluate(() => {
      const iframe = document.createElement("iframe");
      document.body.appendChild(iframe);
      const viewportLink = iframe.contentDocument!.createElement("a");
      const hoverLink = iframe.contentDocument!.createElement("a");
      const sourcePrototype = Object.getPrototypeOf(viewportLink);
      const adoptedViewportLink = document.adoptNode(viewportLink);
      const adoptedHoverLink = document.adoptNode(hoverLink);
      iframe.remove();

      adoptedViewportLink.href =
        "/__prefetch-scope/target?cross-realm-viewport=1";
      adoptedViewportLink.textContent = "Cross-realm viewport target";
      document.body.appendChild(adoptedViewportLink);

      adoptedHoverLink.href = "/__prefetch-scope/target?cross-realm-hover=1";
      adoptedHoverLink.textContent = "Cross-realm hover target";
      adoptedHoverLink.style.cssText = "position:absolute;top:100000px;left:0";
      document.body.appendChild(adoptedHoverLink);
      adoptedHoverLink.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true }),
      );

      return {
        current: adoptedViewportLink instanceof HTMLAnchorElement,
        source: sourcePrototype.isPrototypeOf(adoptedViewportLink),
      };
    });
    expect(realmIdentity).toEqual({ current: false, source: true });
    await expect
      .poll(() =>
        prefetches.some(
          (url) =>
            new URL(url).searchParams.get("cross-realm-viewport") === "1",
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        prefetches.some(
          (url) => new URL(url).searchParams.get("cross-realm-hover") === "1",
        ),
      )
      .toBe(true);

    const navigationRequest = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname ===
          "/__prefetch-scope/files/report.pdf" &&
        new URL(request.url()).searchParams.get("_rsc_partial") === "true" &&
        !isPrefetchRequest(request),
    );
    await page.getByTestId("prefetch-resource").click();
    const request = await navigationRequest;
    expect(new URL(request.url()).searchParams.get("_rsc_partial")).toBe(
      "true",
    );
  });

  test("initial payload carries the delegated-prefetch scope metadata", async ({
    page,
  }) => {
    const response = await page.request.get(
      f.url("/__prefetch-scope?__rsc=1"),
      { headers: { "X-Rango-State": "test:1" } },
    );

    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).toMatch(/"defaultPrefetch"\s*:\s*"viewport"/);
    expect(body).toMatch(/"basename"\s*:\s*"\/__prefetch-scope"/);
  });

  test("a hash-only anchor becomes eligible after navigation", async ({
    page,
  }) => {
    const prefetches: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        isPrefetchRequest(request) &&
        url.pathname === "/__prefetch-scope" &&
        url.searchParams.get("parked") === "1"
      ) {
        prefetches.push(request.url());
      }
    });

    await page.goto(f.url("/__prefetch-scope?parked=1"));
    await waitForHydration(page);
    await page.evaluate(() => {
      const link = document.createElement("a");
      link.href = "/__prefetch-scope?parked=1#hash-target";
      link.textContent = "Persistent hash link";
      link.style.cssText =
        "position:fixed;top:0;left:0;pointer-events:none;z-index:-1";
      document.body.appendChild(link);
    });
    await page.waitForTimeout(500);
    expect(prefetches).toHaveLength(0);

    await page.getByTestId("prefetch-target").click();
    await expect(page).toHaveURL(/\/__prefetch-scope\/target$/);
    await expect.poll(() => prefetches.length).toBeGreaterThan(0);
  });

  test("cache invalidation re-warms a persistent plain anchor", async ({
    page,
  }) => {
    const targetRequests: Request[] = [];
    page.on("request", (request) => {
      if (isInvalidationTarget(request)) targetRequests.push(request);
    });

    await page.goto(f.url("/__prefetch-scope"));
    await waitForHydration(page);
    await expect.poll(() => targetRequests.length).toBeGreaterThan(0);
    const initialState = targetRequests[0]!.headers()["x-rango-state"];
    expect(initialState).toBeTruthy();
    const anchor = await page
      .getByTestId("prefetch-invalidation-target")
      .elementHandle();

    const rewarmed = page.waitForRequest(
      (request) =>
        isInvalidationTarget(request) &&
        request.headers()["x-rango-state"] !== initialState,
    );
    await page.getByTestId("prefetch-invalidation-button").click();
    const request = await rewarmed;

    expect(request.headers()["x-rango-state"]).toBeTruthy();
    expect(request.headers()["x-rango-state"]).not.toBe(initialState);
    expect(await anchor!.evaluate((element) => element.isConnected)).toBe(true);
  });

  test("a server action keeps a persistent anchor's prefetch stale: the click shows it at once, one revalidation sends the write, in place", async ({
    page,
  }) => {
    const targetRequests: Request[] = [];
    const navigations: Request[] = [];
    page.on("request", (request) => {
      if (isInvalidationTarget(request)) targetRequests.push(request);
      else if (isInvalidationTargetNavigation(request)) {
        navigations.push(request);
      }
    });

    await page.goto(f.url("/__prefetch-scope"));
    await waitForHydration(page);
    await expect.poll(() => targetRequests.length).toBeGreaterThan(0);
    const initialState = targetRequests[0]!.headers()["x-rango-state"];
    expect(initialState).toBeTruthy();
    const prefetchCount = targetRequests.length;

    // The action (no directive) marks the prefetch stale instead of flushing
    // it (#1329): the anchor is not prefetched again and the state's
    // timestamp is kept. Its response bumps only the write part.
    const written = await incrementCounter(page);
    await page.waitForTimeout(1000);
    expect(targetRequests).toHaveLength(prefetchCount);
    const writtenState = await readState(page);
    expect(writtenState).not.toBe(initialState);
    expect(stateEpochOf(writtenState)).toBe(stateEpochOf(initialState));
    expect(navigations).toHaveLength(0);

    // A click with no pointer move over the anchor (a hover would replace the
    // stale prefetch, below). 1) It shows the prefetch made before the write
    // at once, with no request of its own. 2) One stale revalidation follows,
    // for the segments on screen. 3) The page then shows the write, in place.
    await recordTexts(page, "target-count");
    await page
      .getByTestId("prefetch-invalidation-target")
      .dispatchEvent("click");
    await expect(page).toHaveURL(/\/__prefetch-scope\/target\?invalidation=1$/);
    await expect(
      page.getByRole("heading", { name: "Prefetch target" }),
    ).toBeVisible();
    await expect(page.getByTestId("target-count")).toHaveText(String(written));
    // The counter is shared with other suites, so the prefetched value is
    // read from the page, not derived from `written`: any value from before
    // this write, then the write.
    const texts = await readTexts(page);
    expect(texts, "the prefetched page, then the write").toHaveLength(2);
    expect(texts[1]).toBe(String(written));
    expect(
      Number(texts[0]),
      "the prefetch was made before the write",
    ).toBeLessThan(written);
    expect(await sameElement(page), "updated in place").toBe(true);
    await page.waitForTimeout(500);
    expect(navigations, "exactly one request, the revalidation").toHaveLength(
      1,
    );
    const revalidation = new URL(navigations[0]!.url());
    expect(revalidation.searchParams.get("_rsc_stale")).toBe("true");
    expect(revalidation.searchParams.get("_rsc_segments")).toBeTruthy();
    // It sends the bumped state: the browser HTTP cache misses.
    expect(navigations[0]!.headers()["x-rango-state"]).toBe(writtenState);
    expect(targetRequests).toHaveLength(prefetchCount);
    expect(await readState(page)).toBe(writtenState);
  });

  test("a hover after a server action replaces the stale prefetch with a fresh one: the click shows the write at once and revalidates nothing", async ({
    page,
  }) => {
    const targetRequests: Request[] = [];
    const navigations: Request[] = [];
    page.on("request", (request) => {
      if (isInvalidationTarget(request)) targetRequests.push(request);
      else if (isInvalidationTargetNavigation(request)) {
        navigations.push(request);
      }
    });

    await page.goto(f.url("/__prefetch-scope"));
    await waitForHydration(page);
    await expect.poll(() => targetRequests.length).toBeGreaterThan(0);
    const initialState = targetRequests[0]!.headers()["x-rango-state"];
    const prefetchCount = targetRequests.length;

    const written = await incrementCounter(page);

    // The pointer enters the anchor: the stale entry counts as absent, so the
    // hover prefetches it again, and the click adopts that fresh one.
    await page.getByTestId("prefetch-invalidation-target").hover();
    await expect
      .poll(() => targetRequests.length)
      .toBeGreaterThan(prefetchCount);
    // With the state the action's response bumped: a prefetch the browser
    // HTTP cache holds from before the write does not answer it.
    const sentState = targetRequests.at(-1)!.headers()["x-rango-state"];
    expect(sentState).toBe(await readState(page));
    expect(sentState).not.toBe(initialState);
    expect(stateEpochOf(sentState)).toBe(stateEpochOf(initialState));
    await recordTexts(page, "target-count");
    await page.getByTestId("prefetch-invalidation-target").click();
    await expect(page.getByTestId("target-count")).toHaveText(String(written));
    await page.waitForTimeout(500);
    expect(await readTexts(page), "the write, shown once").toEqual([
      String(written),
    ]);
    expect(navigations, "no request of the click's own").toHaveLength(0);
  });

  test("invalidateClientCache() in a server action re-warms a persistent plain anchor with a new state", async ({
    page,
  }) => {
    const targetRequests: Request[] = [];
    page.on("request", (request) => {
      if (isInvalidationTarget(request)) targetRequests.push(request);
    });

    await page.goto(f.url("/__prefetch-scope"));
    await waitForHydration(page);
    await expect.poll(() => targetRequests.length).toBeGreaterThan(0);
    const initialState = targetRequests[0]!.headers()["x-rango-state"];
    expect(initialState).toBeTruthy();
    const anchor = await page
      .getByTestId("prefetch-invalidation-target")
      .elementHandle();

    const rewarmed = page.waitForRequest(
      (request) =>
        isInvalidationTarget(request) &&
        request.headers()["x-rango-state"] !== initialState,
    );
    await page.getByTestId("prefetch-action-invalidation-button").click();
    const request = await rewarmed;

    expect(request.headers()["x-rango-state"]).toBeTruthy();
    expect(request.headers()["x-rango-state"]).not.toBe(initialState);
    expect(await readState(page)).toBe(request.headers()["x-rango-state"]);
    expect(await anchor!.evaluate((element) => element.isConnected)).toBe(true);
  });
}

test.describe("delegated-prefetch-scope", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runDelegatedPrefetchScopeSpec(f);
});

test.describe("delegated-prefetch-scope (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runDelegatedPrefetchScopeSpec(f);
});
