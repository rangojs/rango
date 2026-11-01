import { expect, test, type Page } from "@playwright/test";
import { waitForShellHydration } from "./shell-request.js";

/**
 * rango-t82: a prefetch answer with nothing live in it carries the router's
 * prefetch Cache-Control (`private, max-age=<prefetchCacheTTL>`), so the
 * browser HTTP cache can answer a later prefetch or the click with it: a
 * route cache() HIT whose every sent segment is stored and runs no loader, a
 * Prerender entry with no loader, a document cache HIT. Any answer with a
 * live segment or a loader carries none: it can fail after its 200 left
 * (#1170; a failed prefetch's own headers: prefetch-render-errors-scenario.ts).
 *
 * Fixture: prefetch-stored* in each app, mounted at "/prefetch-stored": a
 * layout of hover-prefetch links above `/home`, cache() routes `/cached` and
 * `/cached-loader` (a loader), a live layout above cache() routes
 * `/section/a` and `/section/b`, a Prerender `/baked`, and `/doc/page`
 * (s-maxage and a loader) behind the document cache. Each page renders a
 * fresh stamp, so an answer that repeats the MISS's stamp came from storage.
 * ?k keys the records and documents to one test. Both apps call this from a
 * dev and a (production) describe.
 */
export interface PrefetchStoredScenarioOptions {
  url: (pathname: string) => string;
  /** The app's prefetchCacheTTL, in seconds. */
  ttlSeconds: number;
}

const BASE = "/prefetch-stored";

interface Prefetched {
  cacheControl: string | undefined;
  documentCache: string | undefined;
  stamp: string | undefined;
}

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await waitForShellHydration(page);
}

/** Hovers the link to `name`; resolves with its prefetch once it ended. */
async function hoverPrefetch(
  page: Page,
  name: string,
  pathname: string,
): Promise<Prefetched> {
  const prefetched = page.waitForResponse((resp) => {
    const url = new URL(resp.url());
    return (
      url.pathname === `${BASE}${pathname}` &&
      url.searchParams.has("_rsc_partial") &&
      resp.request().headers()["x-rango-prefetch"] !== undefined
    );
  });
  await page.getByTestId(`ps-to-${name}`).hover();
  const response = await prefetched;
  const body = (await response.body()).toString();
  return {
    cacheControl: response.headers()["cache-control"],
    documentCache: response.headers()["x-document-cache-status"],
    stamp: /ps-stamp:[\w-]+:(\w+)/.exec(body)?.[1],
  };
}

const key = () => `k${Date.now()}${Math.random().toString(36).slice(2, 8)}`;

export function runPrefetchStoredTests(
  options: PrefetchStoredScenarioOptions,
): void {
  const STORED = `private, max-age=${options.ttlSeconds}`;

  /**
   * The first prefetch of `name` from `from` renders it, and the record is
   * written in the background (by a render of its own when the MISS held a
   * segment back). Once the store has it, each new document's prefetch
   * repeats the stamp of the one before: `expectHit` checks that answer.
   */
  async function missThenHit(
    page: Page,
    from: string,
    name: string,
    pathname: string,
    expectHit: (hit: Prefetched) => void,
  ): Promise<Prefetched> {
    const fromUrl = options.url(`${BASE}${from}?k=${key()}`);
    await open(page, fromUrl);
    const miss = await hoverPrefetch(page, name, pathname);
    expect(miss.stamp).toBeDefined();
    let previous = miss.stamp;
    await expect(async () => {
      await open(page, fromUrl);
      const hit = await hoverPrefetch(page, name, pathname);
      const repeated = hit.stamp === previous;
      previous = hit.stamp;
      expect(repeated, "the answer came from storage").toBe(true);
      expectHit(hit);
    }).toPass({ timeout: 20_000 });
    return miss;
  }

  test("a prefetch a cache() record answers carries the prefetch Cache-Control; the MISS that rendered it carries none", async ({
    page,
  }) => {
    const miss = await missThenHit(page, "/home", "cached", "/cached", (hit) =>
      expect(hit.cacheControl).toBe(STORED),
    );
    expect(miss.cacheControl).toBeUndefined();
  });

  test("a prefetch a cache() record answers carries none when a loader runs in it", async ({
    page,
  }) => {
    await missThenHit(page, "/home", "cached-loader", "/cached-loader", (hit) =>
      expect(hit.cacheControl).toBeUndefined(),
    );
  });

  test("a prefetch a cache() record answers carries none when a live layout above it is sent", async ({
    page,
  }) => {
    // /home does not hold the section layout: it renders live.
    await missThenHit(page, "/home", "section-b", "/section/b", (hit) =>
      expect(hit.cacheControl).toBeUndefined(),
    );
  });

  test("a prefetch a cache() record answers carries it when the client keeps the live layout above it", async ({
    page,
  }) => {
    await missThenHit(page, "/section/a", "section-b", "/section/b", (hit) =>
      expect(hit.cacheControl).toBe(STORED),
    );
  });

  test("a prefetch a Prerender entry answers carries it when the route has no loader", async ({
    page,
  }) => {
    await open(page, options.url(`${BASE}/home?k=${key()}`));
    const baked = await hoverPrefetch(page, "baked", "/baked");
    expect(baked.stamp).toBe("static");
    expect(baked.cacheControl).toBe(STORED);
  });

  test("a prefetch the document cache answers carries it on a HIT, its loader output replayed; the MISS keeps the route's own", async ({
    page,
  }) => {
    const miss = await missThenHit(page, "/home", "doc", "/doc/page", (hit) => {
      expect(hit.documentCache).toBe("HIT");
      expect(hit.cacheControl).toBe(STORED);
    });
    expect(miss.documentCache).toBe("MISS");
    expect(miss.cacheControl).toBe("s-maxage=60");
  });
}
