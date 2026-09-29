import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * cache() scope guard tests — "least cacheable wins" policy.
 *
 * Validates full cycle:
 * - ctx.set(cacheableVar) inside cache() — allowed
 * - ctx.set(nonCacheableVar) inside cache() — allowed; ctx.get() throws
 * - ctx.set(var, val, { cache: false }) inside cache() — allowed; ctx.get() throws
 * - ctx.get(nonCacheableVar) inside cache() — throws (read guard)
 * - ctx.headers.set() inside cache() — throws (response-level)
 * - getRequestContext().get(nonCacheableVar) inside "use cache" — throws
 */

/**
 * "use cache" and a { cache: false } var set by middleware from ?tenant=
 * (issue #925). Reading it in the cached body throws the guard's error: the
 * server-side onError log carries its message in both modes, the page only in
 * dev (production redacts it). Passed in as an argument, it keys the entry per
 * value.
 */
const USE_CACHE_GUARD_MESSAGE = '"use cache" function';

function defineUseCacheNonCacheableVarTests(
  f: Fixture,
  production: boolean,
): void {
  test('getRequestContext().get(nonCacheable) inside "use cache" should render error boundary', async ({
    page,
    request,
  }) => {
    for (const tenant of ["a", "b"]) {
      await page.goto(
        f.url(`/cache-scope-guard/use-cache-read-blocked?tenant=${tenant}`),
      );
      await waitForHydration(page);
      await expect(page.getByTestId("csg-error-page")).toBeVisible();
      await expect(page.getByTestId("csg-use-cache-value")).toHaveCount(0);
      if (!production) {
        await expect(page.getByTestId("csg-error-message")).toContainText(
          USE_CACHE_GUARD_MESSAGE,
        );
      }
    }

    // Non-destructive read of the router's onError log.
    const log: Array<{ phase: string; message: string }> | null = await (
      await request.get(f.url("/__test/last-error"))
    ).json();
    expect(
      log?.some(
        (e) =>
          e.phase === "handler" && e.message.includes(USE_CACHE_GUARD_MESSAGE),
      ),
      "onError got the guard's error",
    ).toBe(true);
  });

  test('nonCacheable value passed into "use cache" as an argument keys the entry per value', async ({
    request,
  }) => {
    const run = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const read = async (tenant: string) => {
      const res = await request.get(
        f.url(`/cache-scope-guard/use-cache-arg-keyed?tenant=${tenant}`),
        { headers: { Accept: "text/html" } },
      );
      const html = await res.text();
      return {
        tenant: html.match(/csg-use-cache-arg-tenant">([^<]*)</)?.[1],
        stamp: html.match(/csg-use-cache-arg-stamp">([^<]*)</)?.[1],
      };
    };

    // A repeated stamp is a HIT: the background write has landed.
    let a = await read(`a-${run}`);
    await expect
      .poll(async () => {
        const next = await read(`a-${run}`);
        const hit = next.stamp === a.stamp;
        a = next;
        return hit;
      })
      .toBe(true);
    expect(a.tenant).toBe(`a-${run}`);

    const b = await read(`b-${run}`);
    expect(b.tenant).toBe(`b-${run}`);
    expect(b.stamp).not.toBe(a.stamp);
    expect((await read(`a-${run}`)).stamp).toBe(a.stamp);
  });
}

/**
 * A loader bound with its own cache() whose body reads cookies() (#972).
 * Without a key() the entry is shared across users, so the fill fails: the
 * error boundary renders and onError gets the guard's message (the page shows
 * it only in dev; production redacts it). The same holds when a parent layout
 * handler runs the loader first and the route's MISS reuses that run. With a
 * key() that includes the cookie, each session gets its own entry.
 */
const LOADER_CACHE_GUARD_MESSAGE = "whose own cache() has no key()";

function defineLoaderCacheIdentityTests(f: Fixture, production: boolean): void {
  test("cookies() in a loader with its own cache() and no key() renders the error boundary", async ({
    page,
    request,
  }) => {
    for (const session of ["user-a", "user-b"]) {
      await page
        .context()
        .addCookies([{ name: "csg-session", value: session, url: f.url("/") }]);
      await page.goto(f.url("/cache-scope-guard/loader-cache-unkeyed"));
      await waitForHydration(page);
      await expect(page.getByTestId("csg-error-page")).toBeVisible();
      await expect(page.getByTestId("csg-loader-cache-session")).toHaveCount(0);
      if (!production) {
        await expect(page.getByTestId("csg-error-message")).toContainText(
          LOADER_CACHE_GUARD_MESSAGE,
        );
      }
    }

    // By pathname: the reader-first route reports the same message.
    const log: Array<{ message: string; pathname?: string }> | null = await (
      await request.get(f.url("/__test/last-error"))
    ).json();
    expect(
      log?.some(
        (e) =>
          e.pathname === "/cache-scope-guard/loader-cache-unkeyed" &&
          e.message.includes(LOADER_CACHE_GUARD_MESSAGE),
      ),
      "onError got this route's guard error",
    ).toBe(true);
  });

  test("the same when a parent layout handler reads the loader before its binding", async ({
    page,
  }) => {
    const run = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    for (const session of [`a-${run}`, `b-${run}`]) {
      await page
        .context()
        .addCookies([{ name: "csg-session", value: session, url: f.url("/") }]);
      await page.goto(f.url("/cache-scope-guard/loader-cache-reader-first"));
      await waitForHydration(page);
      // The layout's own read is live; the route's fill fails.
      await expect(page.getByTestId("csg-layout-session")).toHaveText(session);
      await expect(page.getByTestId("csg-error-page")).toBeVisible();
      await expect(page.getByTestId("csg-loader-cache-session")).toHaveCount(0);
      if (!production) {
        await expect(page.getByTestId("csg-error-message")).toContainText(
          LOADER_CACHE_GUARD_MESSAGE,
        );
      }
    }
  });

  test("a loader with its own cache() and a key() that includes the cookie gives each user their own value", async ({
    request,
  }) => {
    const run = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const read = async (session: string) => {
      const res = await request.get(
        f.url("/cache-scope-guard/loader-cache-keyed"),
        {
          headers: { Accept: "text/html", Cookie: `csg-session=${session}` },
        },
      );
      expect(res.status()).toBe(200);
      const html = await res.text();
      return {
        session: html.match(/csg-loader-cache-session">([^<]*)</)?.[1],
        stamp: html.match(/csg-loader-cache-stamp">([^<]*)</)?.[1],
      };
    };

    // A repeated stamp is a HIT: the background write has landed.
    let a = await read(`a-${run}`);
    await expect
      .poll(async () => {
        const next = await read(`a-${run}`);
        const hit = next.stamp === a.stamp;
        a = next;
        return hit;
      })
      .toBe(true);
    expect(a.session).toBe(`a-${run}`);

    const b = await read(`b-${run}`);
    expect(b.session).toBe(`b-${run}`);
    expect(b.stamp).not.toBe(a.stamp);
    expect(await read(`a-${run}`)).toEqual(a);
  });
}

// ============================================================================
// Dev
// ============================================================================

test.describe("cache-scope-guard", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  defineUseCacheNonCacheableVarTests(f, false);
  defineLoaderCacheIdentityTests(f, false);

  test("ctx.set(cacheable var) inside cache() should be allowed", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-scope-guard/set-allowed"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-set-page")).toBeVisible();
    await expect(page.getByTestId("csg-set-value")).toHaveText(
      "from-cached-handler",
    );
  });

  test("ctx.headers.set() inside cache() should throw", async ({ page }) => {
    await page.goto(f.url("/cache-scope-guard/header-blocked"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-error-page")).toBeVisible();
    await expect(page.getByTestId("csg-error-message")).toContainText(
      "cache() boundary",
    );
  });

  test("ctx.get(nonCacheable var) inside cache() should throw after set", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/var-blocked"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-error-page")).toBeVisible();
    await expect(page.getByTestId("csg-error-message")).toContainText(
      "non-cacheable",
    );
  });

  test("ctx.get(var set with cache:false) inside cache() should throw", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/write-blocked"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-error-page")).toBeVisible();
    await expect(page.getByTestId("csg-error-message")).toContainText(
      "non-cacheable",
    );
  });

  test("ctx.get(nonCacheable var) inside cache() should throw (read guard)", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/read-blocked"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-error-page")).toBeVisible();
    await expect(page.getByTestId("csg-error-message")).toContainText(
      "non-cacheable",
    );
  });

  test("@meta parallel reading non-cacheable var inside cache() should throw", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/parallel-read-blocked"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-error-page")).toBeVisible();
    await expect(page.getByTestId("csg-error-message")).toContainText(
      "non-cacheable",
    );
  });

  test("getRequestContext().get(nonCacheable) inside cache() should throw", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/reqctx-read-blocked"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-error-page")).toBeVisible();
    await expect(page.getByTestId("csg-error-message")).toContainText(
      "non-cacheable",
    );
  });

  test("getRequestContext().header() inside cache() should throw", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/reqctx-header-blocked"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-error-page")).toBeVisible();
    await expect(page.getByTestId("csg-error-message")).toContainText(
      "cache() boundary",
    );
  });

  test("loader reading non-cacheable var inside cache() should be allowed", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-scope-guard/loader-read-allowed"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-loader-page")).toBeVisible();
    await expect(page.getByTestId("csg-loader-value")).toHaveText(
      "loader-session",
    );
  });

  test("async loader reading non-cacheable var after await should be allowed", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-scope-guard/async-loader-read-allowed"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-async-loader-page")).toBeVisible();
    await expect(page.getByTestId("csg-async-loader-value")).toHaveText(
      "loader-session",
    );
  });

  test("loader calling cookies().set() inside cache() should be allowed", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-scope-guard/loader-cookie-allowed"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-loader-cookie-page")).toBeVisible();
    await expect(page.getByTestId("csg-loader-cookie-value")).toHaveText(
      "cookie-written",
    );
  });

  test("handler-invoked loader writing a cookie inside cache() should throw (#725)", async ({
    page,
  }) => {
    const response = await page.goto(
      f.url("/cache-scope-guard/handler-loader-cookie-blocked"),
    );
    await waitForHydration(page);

    await expect(page.getByTestId("csg-error-page")).toBeVisible();
    await expect(page.getByTestId("csg-error-message")).toContainText(
      "cache() boundary",
    );
    await expect(page.getByTestId("csg-error-message")).toContainText(
      "from a loader",
    );
    // Divergence pin: the MISS-only Set-Cookie never reaches the wire.
    expect(response?.headers()["set-cookie"] ?? "").not.toContain(
      "csg-hil-cookie",
    );
  });

  test("ctx.headers.set() inside cache() should throw (SSR)", async ({
    request,
  }) => {
    const response = await request.get(
      f.url("/cache-scope-guard/header-blocked"),
      { headers: { Accept: "text/html,application/xhtml+xml" } },
    );
    const html = await response.text();
    expect(html).toContain("cache() boundary");
  });

  test("cookies() read inside cache() should throw", async ({ page }) => {
    await page.goto(f.url("/cache-scope-guard/cookies-read-blocked"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-error-page")).toBeVisible();
    await expect(page.getByTestId("csg-error-message")).toContainText(
      "cache() boundary",
    );
  });

  test("headers() read inside cache() should throw", async ({ page }) => {
    await page.goto(f.url("/cache-scope-guard/headers-read-blocked"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-error-page")).toBeVisible();
    await expect(page.getByTestId("csg-error-message")).toContainText(
      "cache() boundary",
    );
  });

  test("cookies() read by a loader consumed via useLoader inside cache() is fresh per request (no cached-shell leak)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    const url = f.url("/cache-scope-guard/loader-cookies-allowed");
    const root = f.url("/");

    // First visitor: cookie "alice" — populates the cached static shell.
    await page
      .context()
      .addCookies([{ name: "csg-session", value: "alice", url: root }]);
    await page.goto(url);
    await waitForHydration(page);
    await expect(page.getByTestId("csg-loader-cookies-value")).toHaveText(
      "alice",
    );

    // Second visitor: cookie "bob" — same URL, so the cached shell is served,
    // but the cookie value rides the FRESH loader segment. If the cookie had
    // been baked into the cached handler, bob would see "alice" (the leak).
    await page.context().clearCookies();
    await page
      .context()
      .addCookies([{ name: "csg-session", value: "bob", url: root }]);
    await page.goto(url);
    await waitForHydration(page);
    await expect(page.getByTestId("csg-loader-cookies-value")).toHaveText(
      "bob",
    );
  });

  test("cookies() read inside cache() should throw (SSR)", async ({
    request,
  }) => {
    const response = await request.get(
      f.url("/cache-scope-guard/cookies-read-blocked"),
      { headers: { Accept: "text/html,application/xhtml+xml" } },
    );
    const html = await response.text();
    expect(html).toContain("cache() boundary");
  });
});

// ============================================================================
// Production
// ============================================================================

test.describe("cache-scope-guard (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  defineUseCacheNonCacheableVarTests(f, true);
  defineLoaderCacheIdentityTests(f, true);

  test("ctx.set(cacheable var) inside cache() should be allowed", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-scope-guard/set-allowed"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-set-page")).toBeVisible();
    await expect(page.getByTestId("csg-set-value")).toHaveText(
      "from-cached-handler",
    );
  });

  test("ctx.headers.set() inside cache() should render error boundary", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/header-blocked"));
    await waitForHydration(page);
    await expect(page.getByTestId("csg-error-page")).toBeVisible();
  });

  test("ctx.get(nonCacheable var) inside cache() should render error boundary after set", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/var-blocked"));
    await waitForHydration(page);
    await expect(page.getByTestId("csg-error-page")).toBeVisible();
  });

  test("ctx.get(var set with cache:false) inside cache() should render error boundary", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/write-blocked"));
    await waitForHydration(page);
    await expect(page.getByTestId("csg-error-page")).toBeVisible();
  });

  test("ctx.get(nonCacheable var) inside cache() should render error boundary (read guard)", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/read-blocked"));
    await waitForHydration(page);
    await expect(page.getByTestId("csg-error-page")).toBeVisible();
  });

  test("@meta parallel reading non-cacheable var inside cache() should render error boundary", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/parallel-read-blocked"));
    await waitForHydration(page);
    await expect(page.getByTestId("csg-error-page")).toBeVisible();
  });

  test("loader reading non-cacheable var inside cache() should be allowed", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-scope-guard/loader-read-allowed"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-loader-page")).toBeVisible();
    await expect(page.getByTestId("csg-loader-value")).toHaveText(
      "loader-session",
    );
  });

  test("async loader reading non-cacheable var after await should be allowed", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-scope-guard/async-loader-read-allowed"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-async-loader-page")).toBeVisible();
    await expect(page.getByTestId("csg-async-loader-value")).toHaveText(
      "loader-session",
    );
  });

  test("loader calling cookies().set() inside cache() should be allowed", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/cache-scope-guard/loader-cookie-allowed"));
    await waitForHydration(page);

    await expect(page.getByTestId("csg-loader-cookie-page")).toBeVisible();
    await expect(page.getByTestId("csg-loader-cookie-value")).toHaveText(
      "cookie-written",
    );
  });

  test("handler-invoked loader writing a cookie inside cache() should render error boundary (#725)", async ({
    page,
  }) => {
    // Production redacts the error message, so assert the boundary rendered and
    // pin the divergence: the MISS-only Set-Cookie never reaches the wire.
    const response = await page.goto(
      f.url("/cache-scope-guard/handler-loader-cookie-blocked"),
    );
    await waitForHydration(page);

    await expect(page.getByTestId("csg-error-page")).toBeVisible();
    expect(response?.headers()["set-cookie"] ?? "").not.toContain(
      "csg-hil-cookie",
    );
  });

  test("getRequestContext().get(nonCacheable) inside cache() should render error boundary", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/reqctx-read-blocked"));
    await waitForHydration(page);
    await expect(page.getByTestId("csg-error-page")).toBeVisible();
  });

  test("getRequestContext().header() inside cache() should render error boundary", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/reqctx-header-blocked"));
    await waitForHydration(page);
    await expect(page.getByTestId("csg-error-page")).toBeVisible();
  });

  test("cookies() read inside cache() should render error boundary", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/cookies-read-blocked"));
    await waitForHydration(page);
    await expect(page.getByTestId("csg-error-page")).toBeVisible();
  });

  test("headers() read inside cache() should render error boundary", async ({
    page,
  }) => {
    await page.goto(f.url("/cache-scope-guard/headers-read-blocked"));
    await waitForHydration(page);
    await expect(page.getByTestId("csg-error-page")).toBeVisible();
  });

  test("cookies() read by a loader consumed via useLoader inside cache() is fresh per request (no cached-shell leak)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    const url = f.url("/cache-scope-guard/loader-cookies-allowed");
    const root = f.url("/");

    await page
      .context()
      .addCookies([{ name: "csg-session", value: "alice", url: root }]);
    await page.goto(url);
    await waitForHydration(page);
    await expect(page.getByTestId("csg-loader-cookies-value")).toHaveText(
      "alice",
    );

    await page.context().clearCookies();
    await page
      .context()
      .addCookies([{ name: "csg-session", value: "bob", url: root }]);
    await page.goto(url);
    await waitForHydration(page);
    await expect(page.getByTestId("csg-loader-cookies-value")).toHaveText(
      "bob",
    );
  });
});
