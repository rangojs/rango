import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";

/**
 * Cache isolation tests.
 *
 * Proves that cached responses do not leak across request boundaries:
 *   1. Different query params produce separate cache entries.
 *   2. Auth-keyed cache isolates authenticated vs unauthenticated responses.
 *   3. Default cache key (no auth) shares entries across auth states (by design).
 *   4. condition() skips cache for specific requests.
 *   5. onResponse callbacks from app-level middleware produce fresh values per serve.
 *   6. Behavior is identical in dev and production.
 */

// ---------------------------------------------------------------------------
// Dev mode
// ---------------------------------------------------------------------------

test.describe("cache-isolation (dev)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });

  test.describe("query param isolation", () => {
    test("same path, different query params get separate cache entries", async ({
      request,
    }) => {
      // Request variant A
      const resA1 = await request.get(
        f.url("/cache-isolation/query-variant?v=alpha"),
      );
      expect(resA1.status()).toBe(200);
      const bodyA1 = await resA1.json();
      expect(bodyA1.variant).toBe("alpha");
      const tsA = bodyA1.ts;

      // Request variant B — must NOT reuse variant A's cache
      const resB1 = await request.get(
        f.url("/cache-isolation/query-variant?v=beta"),
      );
      expect(resB1.status()).toBe(200);
      const bodyB1 = await resB1.json();
      expect(bodyB1.variant).toBe("beta");

      // Negative: B's data is not A's data
      expect(bodyB1.variant).not.toBe("alpha");

      // Verify A's entry is cached (poll for async cache write)
      await expect(async () => {
        const resA2 = await request.get(
          f.url("/cache-isolation/query-variant?v=alpha"),
        );
        const bodyA2 = await resA2.json();
        expect(bodyA2.ts).toBe(tsA);
        expect(bodyA2.variant).toBe("alpha");
      }).toPass({ timeout: 5_000 });
    });
  });

  test.describe("auth-keyed cache isolation", () => {
    test("unauthenticated request populates anon cache entry", async ({
      request,
    }) => {
      const res1 = await request.get(f.url("/cache-isolation/auth-keyed"));
      expect(res1.status()).toBe(200);
      const body1 = await res1.json();
      expect(body1.user).toBe("anonymous");
      expect(body1.secret).toBeNull();
      const anonTs = body1.ts;

      // Verify anon entry is cached
      await expect(async () => {
        const res2 = await request.get(f.url("/cache-isolation/auth-keyed"));
        const body2 = await res2.json();
        expect(body2.ts).toBe(anonTs);
      }).toPass({ timeout: 5_000 });
    });

    test("authenticated request does NOT inherit anon cached response", async ({
      page,
      context,
    }) => {
      // Seed the anon cache entry first
      const anonRes = await page.goto(f.url("/cache-isolation/auth-keyed"));
      const anonBody = await anonRes?.json();
      const anonTs = anonBody.ts;

      // Wait for cache write
      await expect(async () => {
        const check = await page.goto(f.url("/cache-isolation/auth-keyed"));
        const checkBody = await check?.json();
        expect(checkBody.ts).toBe(anonTs);
      }).toPass({ timeout: 5_000 });

      // Now authenticate
      await context.addCookies([
        {
          name: "iso-token",
          value: "valid",
          domain: "localhost",
          path: "/",
        },
      ]);

      const authRes = await page.goto(f.url("/cache-isolation/auth-keyed"));
      const authBody = await authRes?.json();

      // Must see authenticated data, NOT the anon cached response
      expect(authBody.user).toBe("authenticated");
      expect(authBody.secret).toBe("classified-data");
      // Timestamp must differ (separate cache entry, handler re-executed)
      expect(authBody.ts).not.toBe(anonTs);
    });

    test("anon request after auth cache does NOT see classified data", async ({
      page,
      context,
      request,
    }) => {
      // Authenticate and seed the auth cache entry
      await context.addCookies([
        {
          name: "iso-token",
          value: "valid",
          domain: "localhost",
          path: "/",
        },
      ]);

      const authRes = await page.goto(f.url("/cache-isolation/auth-keyed"));
      const authBody = await authRes?.json();
      expect(authBody.user).toBe("authenticated");
      expect(authBody.secret).toBe("classified-data");

      // Now request without auth (use request API — no cookies)
      const anonRes = await request.get(f.url("/cache-isolation/auth-keyed"));
      const anonBody = await anonRes.json();

      // Must see anonymous data, NOT the auth cached response
      expect(anonBody.user).toBe("anonymous");
      expect(anonBody.secret).toBeNull();
    });
  });

  test.describe("default cache key (no auth isolation)", () => {
    test("without custom key, first request's auth state is served to all", async ({
      page,
      context,
      request,
    }) => {
      // Authenticate and seed the cache with auth data
      await context.addCookies([
        {
          name: "iso-token",
          value: "valid",
          domain: "localhost",
          path: "/",
        },
      ]);

      const authRes = await page.goto(f.url("/cache-isolation/no-auth-key"));
      const authBody = await authRes?.json();
      expect(authBody.user).toBe("authenticated");
      const authTs = authBody.ts;

      // Wait for cache write
      await expect(async () => {
        const check = await page.goto(f.url("/cache-isolation/no-auth-key"));
        const checkBody = await check?.json();
        expect(checkBody.ts).toBe(authTs);
      }).toPass({ timeout: 5_000 });

      // Now request without auth — default key has no auth component,
      // so the cached authenticated response is returned (by design).
      const anonRes = await request.get(f.url("/cache-isolation/no-auth-key"));
      const anonBody = await anonRes.json();

      // This PROVES the default key leaks — the unauthenticated request
      // sees the authenticated user's cached response.
      expect(anonBody.user).toBe("authenticated");
      expect(anonBody.ts).toBe(authTs);
    });
  });

  test.describe("condition-gated cache", () => {
    test("unauthenticated request is cached", async ({ request }) => {
      const res1 = await request.get(f.url("/cache-isolation/condition-gated"));
      expect(res1.status()).toBe(200);
      const body1 = await res1.json();
      expect(body1.user).toBe("anonymous");
      const ts1 = body1.ts;

      // Poll until cache write completes
      await expect(async () => {
        const res2 = await request.get(
          f.url("/cache-isolation/condition-gated"),
        );
        const body2 = await res2.json();
        expect(body2.ts).toBe(ts1);
      }).toPass({ timeout: 5_000 });
    });

    test("authenticated request bypasses cache (condition returns false)", async ({
      page,
      context,
    }) => {
      // Seed the anon cache
      const seedRes = await page.goto(
        f.url("/cache-isolation/condition-gated"),
      );
      const seedBody = await seedRes?.json();
      const anonTs = seedBody.ts;

      // Wait for cache write
      await expect(async () => {
        const check = await page.goto(
          f.url("/cache-isolation/condition-gated"),
        );
        const checkBody = await check?.json();
        expect(checkBody.ts).toBe(anonTs);
      }).toPass({ timeout: 5_000 });

      // Authenticate — condition() returns false, so cache is skipped
      await context.addCookies([
        {
          name: "iso-token",
          value: "valid",
          domain: "localhost",
          path: "/",
        },
      ]);

      const authRes = await page.goto(
        f.url("/cache-isolation/condition-gated"),
      );
      const authBody = await authRes?.json();

      // Handler re-executed (not from cache)
      expect(authBody.user).toBe("authenticated");
      expect(authBody.ts).not.toBe(anonTs);
    });
  });

  test.describe("onResponse callback freshness", () => {
    test("pre-handler onResponse callback runs on every serve (not cached)", async ({
      request,
    }) => {
      // This route is under /response-cache/cb-test/ which has
      // a global middleware registering onResponse with fresh Date.now()
      const res1 = await request.get(
        f.url("/response-cache/cb-test/with-route-cb"),
      );
      expect(res1.status()).toBe(200);
      const preTs1 = res1.headers()["x-pre-handler-ts"];
      expect(preTs1).toBeDefined();

      // Wait for cache write, then request again
      await expect(async () => {
        const res2 = await request.get(
          f.url("/response-cache/cb-test/with-route-cb"),
        );
        const body1 = await res1.json();
        const body2 = await res2.json();
        // Body timestamps match (cached)
        expect(body2.ts).toBe(body1.ts);

        // Pre-handler callback timestamp is FRESH (not cached)
        const preTs2 = res2.headers()["x-pre-handler-ts"];
        expect(preTs2).toBeDefined();
        expect(Number(preTs2)).toBeGreaterThanOrEqual(Number(preTs1));
      }).toPass({ timeout: 5_000 });
    });
  });
});

// ---------------------------------------------------------------------------
// Production mode
// ---------------------------------------------------------------------------

test.describe("cache-isolation (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });

  test.describe("query param isolation", () => {
    test("same path, different query params get separate cache entries", async ({
      request,
    }) => {
      const resA1 = await request.get(
        f.url("/cache-isolation/query-variant?v=alpha"),
      );
      const bodyA1 = await resA1.json();
      expect(bodyA1.variant).toBe("alpha");
      const tsA = bodyA1.ts;

      const resB1 = await request.get(
        f.url("/cache-isolation/query-variant?v=beta"),
      );
      const bodyB1 = await resB1.json();
      expect(bodyB1.variant).toBe("beta");
      expect(bodyB1.variant).not.toBe("alpha");

      await expect(async () => {
        const resA2 = await request.get(
          f.url("/cache-isolation/query-variant?v=alpha"),
        );
        const bodyA2 = await resA2.json();
        expect(bodyA2.ts).toBe(tsA);
        expect(bodyA2.variant).toBe("alpha");
      }).toPass({ timeout: 5_000 });
    });
  });

  test.describe("auth-keyed cache isolation", () => {
    test("authenticated request does NOT inherit anon cached response", async ({
      page,
      context,
    }) => {
      // Seed anon cache
      const anonRes = await page.goto(f.url("/cache-isolation/auth-keyed"));
      const anonBody = await anonRes?.json();
      expect(anonBody.user).toBe("anonymous");
      const anonTs = anonBody.ts;

      // Wait for cache write
      await expect(async () => {
        const check = await page.goto(f.url("/cache-isolation/auth-keyed"));
        const checkBody = await check?.json();
        expect(checkBody.ts).toBe(anonTs);
      }).toPass({ timeout: 5_000 });

      // Authenticate
      await context.addCookies([
        {
          name: "iso-token",
          value: "valid",
          domain: "localhost",
          path: "/",
        },
      ]);

      const authRes = await page.goto(f.url("/cache-isolation/auth-keyed"));
      const authBody = await authRes?.json();

      expect(authBody.user).toBe("authenticated");
      expect(authBody.secret).toBe("classified-data");
      expect(authBody.ts).not.toBe(anonTs);
    });

    test("anon request after auth cache does NOT see classified data", async ({
      page,
      context,
      request,
    }) => {
      await context.addCookies([
        {
          name: "iso-token",
          value: "valid",
          domain: "localhost",
          path: "/",
        },
      ]);

      const authRes = await page.goto(f.url("/cache-isolation/auth-keyed"));
      const authBody = await authRes?.json();
      expect(authBody.user).toBe("authenticated");
      expect(authBody.secret).toBe("classified-data");

      const anonRes = await request.get(f.url("/cache-isolation/auth-keyed"));
      const anonBody = await anonRes.json();

      expect(anonBody.user).toBe("anonymous");
      expect(anonBody.secret).toBeNull();
    });
  });

  test.describe("default cache key (no auth isolation)", () => {
    test("without custom key, first request's auth state is served to all", async ({
      page,
      context,
      request,
    }) => {
      await context.addCookies([
        {
          name: "iso-token",
          value: "valid",
          domain: "localhost",
          path: "/",
        },
      ]);

      const authRes = await page.goto(f.url("/cache-isolation/no-auth-key"));
      const authBody = await authRes?.json();
      expect(authBody.user).toBe("authenticated");
      const authTs = authBody.ts;

      await expect(async () => {
        const check = await page.goto(f.url("/cache-isolation/no-auth-key"));
        const checkBody = await check?.json();
        expect(checkBody.ts).toBe(authTs);
      }).toPass({ timeout: 5_000 });

      const anonRes = await request.get(f.url("/cache-isolation/no-auth-key"));
      const anonBody = await anonRes.json();

      // Default key leaks: anon sees auth's cached data
      expect(anonBody.user).toBe("authenticated");
      expect(anonBody.ts).toBe(authTs);
    });
  });

  test.describe("condition-gated cache", () => {
    test("authenticated request bypasses cache (condition returns false)", async ({
      page,
      context,
    }) => {
      // Seed anon cache
      const seedRes = await page.goto(
        f.url("/cache-isolation/condition-gated"),
      );
      const seedBody = await seedRes?.json();
      const anonTs = seedBody.ts;

      await expect(async () => {
        const check = await page.goto(
          f.url("/cache-isolation/condition-gated"),
        );
        const checkBody = await check?.json();
        expect(checkBody.ts).toBe(anonTs);
      }).toPass({ timeout: 5_000 });

      await context.addCookies([
        {
          name: "iso-token",
          value: "valid",
          domain: "localhost",
          path: "/",
        },
      ]);

      const authRes = await page.goto(
        f.url("/cache-isolation/condition-gated"),
      );
      const authBody = await authRes?.json();

      expect(authBody.user).toBe("authenticated");
      expect(authBody.ts).not.toBe(anonTs);
    });
  });

  test.describe("onResponse callback freshness", () => {
    test("pre-handler onResponse callback runs on every serve (not cached)", async ({
      request,
    }) => {
      const res1 = await request.get(
        f.url("/response-cache/cb-test/with-route-cb"),
      );
      expect(res1.status()).toBe(200);
      const preTs1 = res1.headers()["x-pre-handler-ts"];
      expect(preTs1).toBeDefined();

      await expect(async () => {
        const res2 = await request.get(
          f.url("/response-cache/cb-test/with-route-cb"),
        );
        const body1 = await res1.json();
        const body2 = await res2.json();
        expect(body2.ts).toBe(body1.ts);

        const preTs2 = res2.headers()["x-pre-handler-ts"];
        expect(preTs2).toBeDefined();
        expect(Number(preTs2)).toBeGreaterThanOrEqual(Number(preTs1));
      }).toPass({ timeout: 5_000 });
    });
  });
});
