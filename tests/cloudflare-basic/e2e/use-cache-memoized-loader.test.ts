import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

/**
 * A "use cache" function reading a loader a handler or the route's loader()
 * binding started first, or getRequestContext().use() in both (#1011), on workerd (src/pages/use-cache-memo.tsx).
 * Before #1011 the cached function got the request's memoized value
 * unchecked and stored visitor a's cookie value for visitor b. Now it refuses
 * into the error boundary for every visitor, as it does when it starts the
 * loader itself.
 *
 * Each test owns its entries through a unique probe (the servers outlive a
 * test).
 */

const visitor = (name: string) => ({
  Accept: "text/html",
  Cookie: `visitor=${name}`,
});

function uniqueProbe(): string {
  return `ucm-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function runUseCacheMemoSpec(f: Fixture, production: boolean): void {
  for (const route of ["handler-first", "binding", "request-context"]) {
    test(`/${route}: the cached function refuses the cookie-reading loader's value for every visitor`, async ({
      request,
    }) => {
      const url = f.url(`/use-cache-memo/${route}?probe=${uniqueProbe()}`);
      for (const name of ["a", "b"]) {
        const res = await request.get(url, { headers: visitor(name) });
        const html = await res.text();
        expect(html).toContain('data-testid="use-cache-memo-error"');
        expect(html).not.toContain("greeting-for-visitor-");
        if (!production) {
          expect(html).toContain(
            "cookies() cannot be called inside a &quot;use cache&quot; function",
          );
        }
      }
    });
  }

  test("/plain: a loader that reads no cookie is stored and served to every visitor", async ({
    request,
  }) => {
    const url = f.url(`/use-cache-memo/plain?probe=${uniqueProbe()}`);
    const valueFor = async (name: string) => {
      const res = await request.get(url, { headers: visitor(name) });
      expect(res.status()).toBe(200);
      return /plain-greeting-plain@([\d.-]+)/.exec(await res.text())?.[1];
    };
    const a = await valueFor("a");
    expect(a).toBeDefined();
    expect(await valueFor("b")).toBe(a);
  });
}

test.describe("use cache memoized loader", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runUseCacheMemoSpec(f, false);
});

test.describe("use cache memoized loader (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runUseCacheMemoSpec(f, true);
});
