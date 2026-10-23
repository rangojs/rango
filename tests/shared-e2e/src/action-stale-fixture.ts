import { randomUUID } from "node:crypto";
import { expect, type Page, type Request } from "@playwright/test";
import { waitForShellHydration } from "./shell-request.js";

/**
 * Driving the action follow-up fixture (action-stale* in each app) from a
 * browser: its state is keyed by the `as-key` cookie, `<html
 * data-as-pending>` is set while an action is in flight and `<html
 * data-as-result>` holds what its call settled with, and every partial
 * request to its pages is recorded. Used by action-stale-navigation-scenario,
 * action-held-segments-scenario and action-follow-up-scenario.
 */

export interface ActionStaleFixtureOptions {
  url: (pathname: string) => string;
}

export interface PartialRequest {
  /** The pathname from `/action-stale/` on. */
  path: string;
  /** `_rsc_stale`: a whole refetch, or a stale entry's revalidation. */
  stale: boolean;
  /** No segment named (`_rsc_segments` empty): the server renders it whole. */
  whole: boolean;
  prefetch: boolean;
  /** A `prefetch: false` fill (`_rsc_fill`). */
  fill: boolean;
  at: number;
  finished: boolean;
  finishedAt?: number;
  /** Cancelled or failed before its response ended. */
  failed: boolean;
  /** x-document-cache-status: undefined until answered, null when not consulted. */
  status?: string | null;
}

/** The fixture's partial requests from now on, in the order they were sent. */
export function recordPartials(page: Page): PartialRequest[] {
  const sent: PartialRequest[] = [];
  const entries = new Map<Request, PartialRequest>();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      !url.searchParams.has("_rsc_partial") ||
      !url.pathname.includes("/action-stale/")
    ) {
      return;
    }
    const entry: PartialRequest = {
      path: url.pathname.slice(url.pathname.indexOf("/action-stale/")),
      stale: url.searchParams.get("_rsc_stale") === "true",
      whole: !url.searchParams.get("_rsc_segments"),
      prefetch: request.headers()["x-rango-prefetch"] === "1",
      fill: url.searchParams.has("_rsc_fill"),
      at: Date.now(),
      finished: false,
      failed: false,
    };
    sent.push(entry);
    entries.set(request, entry);
  });
  page.on("response", (response) => {
    const entry = entries.get(response.request());
    if (entry) {
      entry.status = response.headers()["x-document-cache-status"] ?? null;
    }
  });
  page.on("requestfinished", (request) => {
    const entry = entries.get(request);
    if (!entry) return;
    entry.finished = true;
    entry.finishedAt = Date.now();
  });
  page.on("requestfailed", (request) => {
    const entry = entries.get(request);
    if (entry) entry.failed = true;
  });
  return sent;
}

/** The requests for `path` that are not prefetches, in the order sent. */
export function navigations(
  sent: PartialRequest[],
  path: string,
): PartialRequest[] {
  return sent.filter((entry) => entry.path === path && !entry.prefetch);
}

/** The follow-ups sent so far: whole, stale refetches of a page. */
export function followUps(sent: PartialRequest[]): PartialRequest[] {
  return sent.filter((entry) => entry.whole && entry.stale && !entry.prefetch);
}

export async function prefetched(
  sent: PartialRequest[],
  path: string,
): Promise<void> {
  await expect
    .poll(() =>
      sent.some(
        (entry) => entry.prefetch && entry.finished && entry.path === path,
      ),
    )
    .toBe(true);
}

export async function useKey(
  page: Page,
  options: ActionStaleFixtureOptions,
  key: string,
): Promise<void> {
  await page
    .context()
    .addCookies([{ name: "as-key", value: key, url: options.url("/") }]);
}

/** Whether an action is in flight (<html data-as-pending>). */
export async function isPending(page: Page): Promise<boolean> {
  return (await page.locator("html").getAttribute("data-as-pending")) !== null;
}

/**
 * Resolves on the frame the element appears, not at expect()'s next poll: a
 * check made right after it is still inside the action's flight.
 */
export async function waitForShown(page: Page, testId: string): Promise<void> {
  await page.waitForFunction(
    (id) => document.querySelector(`[data-testid="${id}"]`) !== null,
    testId,
    { polling: "raf" },
  );
}

export async function waitForSettled(page: Page): Promise<void> {
  await expect(page.locator("html")).not.toHaveAttribute("data-as-pending");
}

/** Resolves on the frame the action settles, like waitForShown. */
export async function waitForSettledNow(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !document.documentElement.hasAttribute("data-as-pending"),
    null,
    { polling: "raf" },
  );
}

/**
 * The product page under a fresh key (cart 0), and the partial requests made
 * from its load on.
 */
export async function openProductPage(
  page: Page,
  options: ActionStaleFixtureOptions,
  search = "",
): Promise<PartialRequest[]> {
  await useKey(page, options, randomUUID());
  const sent = recordPartials(page);
  await page.goto(options.url(`/action-stale/pdp${search}`));
  await waitForShellHydration(page);
  await expect(page.getByTestId("as-cart")).toHaveText("cart:0");
  return sent;
}

/** A state useNavigation() showed, and whether a page was on screen. */
export interface NavigationValue {
  state: string;
  shown: boolean;
}

/**
 * Records every state useNavigation() shows from now on, with whether the
 * element `testId` was on screen when it did. Read the record with
 * readNavigationStates.
 */
export async function recordNavigationStates(
  page: Page,
  testId: string,
): Promise<void> {
  await page.evaluate((id) => {
    const read = () =>
      document.querySelector('[data-testid="as-navigation"]')?.textContent;
    const seen: { state: string; shown: boolean }[] = [];
    let last = read();
    new MutationObserver(() => {
      const state = read();
      if (state == null || state === last) return;
      last = state;
      seen.push({
        state,
        shown: !!document.querySelector(`[data-testid="${id}"]`),
      });
    }).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    Object.assign(self, { __asNavigationSeen: seen });
  }, testId);
}

export async function readNavigationStates(
  page: Page,
): Promise<NavigationValue[]> {
  return page.evaluate(
    () =>
      (self as unknown as { __asNavigationSeen: NavigationValue[] })
        .__asNavigationSeen,
  );
}
