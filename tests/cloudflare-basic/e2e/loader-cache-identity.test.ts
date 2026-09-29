import { expect, test, type APIRequestContext } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

/**
 * A loader with its own cache() whose body reads cookies() (#972), against
 * the real CFCacheStore. Fixture: /loader-cache-identity/* (urls.tsx). The
 * loader entry is keyed by loader, host, path and params. Without a key() it
 * would be shared across users, so the fill fails: the error boundary renders
 * and onError gets the guard's message (the page shows it only in dev;
 * production redacts it). The same holds when a parent layout handler runs
 * the loader first and the route's MISS reuses that run. With a key() that
 * includes the cookie, each session gets its own entry. Before, the second
 * user got the first user's session for the TTL.
 */
const GUARD_MESSAGE = "whose own cache() has no key()";

function defineLoaderCacheIdentityTests(f: Fixture, production: boolean) {
  async function read(
    request: APIRequestContext,
    path: string,
    session: string,
  ) {
    const res = await request.get(f.url(path), {
      headers: { Accept: "text/html", Cookie: `lci-session=${session}` },
    });
    const html = await res.text();
    return {
      status: res.status(),
      html,
      session: /data-testid="lci-session"[^>]*>([^<]*)</.exec(html)?.[1],
      stamp: /data-testid="lci-stamp"[^>]*>([^<]*)</.exec(html)?.[1],
    };
  }

  test("without a key(): the cookies() read throws for every user and nothing leaks", async ({
    request,
  }) => {
    const run = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    for (const session of [`a-${run}`, `b-${run}`]) {
      const res = await read(
        request,
        "/loader-cache-identity/unkeyed",
        session,
      );
      expect(res.html).toContain('data-testid="lci-error"');
      expect(res.session).toBeUndefined();
      expect(res.html).not.toContain(`a-${run}`);
      if (!production) expect(res.html).toContain(GUARD_MESSAGE);
    }

    // By pathname: the reader-first route reports the same message.
    const log: Array<{ message: string; pathname?: string }> | null = await (
      await request.get(f.url("/__test/last-error"))
    ).json();
    expect(
      log?.some(
        (e) =>
          e.pathname === "/loader-cache-identity/unkeyed" &&
          e.message.includes(GUARD_MESSAGE),
      ),
      "onError got this route's guard error",
    ).toBe(true);
  });

  test("the same when a parent layout handler reads the loader before its binding", async ({
    request,
  }) => {
    const run = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    for (const session of [`a-${run}`, `b-${run}`]) {
      const res = await read(
        request,
        "/loader-cache-identity/reader-first",
        session,
      );
      // The layout's own read is live; the route's fill fails.
      expect(
        /data-testid="lci-layout-session"[^>]*>([^<]*)</.exec(res.html)?.[1],
      ).toBe(session);
      expect(res.html).toContain('data-testid="lci-error"');
      expect(res.session).toBeUndefined();
      if (session.startsWith("b-")) {
        expect(res.html).not.toContain(`a-${run}`);
      }
      if (!production) expect(res.html).toContain(GUARD_MESSAGE);
    }
  });

  test("with a key() that includes the cookie: each user gets their own value, and a HIT serves it", async ({
    request,
  }) => {
    const run = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const path = "/loader-cache-identity/keyed";

    // A repeated stamp is a HIT: the background write has landed.
    let a = await read(request, path, `a-${run}`);
    await expect
      .poll(
        async () => {
          const next = await read(request, path, `a-${run}`);
          const hit = next.stamp === a.stamp;
          a = next;
          return hit;
        },
        { timeout: 15000, message: "expected a loader-cache HIT" },
      )
      .toBe(true);
    expect(a.status).toBe(200);
    expect(a.session).toBe(`a-${run}`);

    const b = await read(request, path, `b-${run}`);
    expect(b.session).toBe(`b-${run}`);
    expect(b.stamp).not.toBe(a.stamp);

    const aAgain = await read(request, path, `a-${run}`);
    expect(aAgain.session).toBe(`a-${run}`);
    expect(aAgain.stamp).toBe(a.stamp);
  });
}

test.describe("loader cache() request identity (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  defineLoaderCacheIdentityTests(f, false);
});

test.describe("loader cache() request identity (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  defineLoaderCacheIdentityTests(f, true);
});
