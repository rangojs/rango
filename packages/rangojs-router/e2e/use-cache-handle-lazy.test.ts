import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

/**
 * A "use cache" function pushes lazy state into a handle (a React.lazy, a
 * memoizing thenable, or one a loader it reads pushes) and returns a value
 * whose encode outlasts the handler (test-app/src/urls/use-cache-handle-lazy.tsx).
 * The pushes are encoded inside the function's guard and the page gets the
 * decoded copy, so the response's render never starts the lazy state with
 * visitor a's cookie, and the entry never serves it to visitor b. The same
 * shapes reading nothing request-scoped are stored and replayed.
 *
 * Each test owns its entry through a unique probe (the servers outlive a
 * test).
 */

const visitor = (name: string) => ({
  Accept: "text/html",
  Cookie: `visitor=${name}`,
});

function uniqueProbe(): string {
  return `uchl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function runUseCacheHandleLazySpec(f: Fixture): void {
  for (const shape of ["lazy-component", "thenable", "loader-thenable"]) {
    test(`/${shape}: the pushed lazy state never serves visitor a's cookie to visitor b`, async ({
      request,
    }) => {
      const url = f.url(
        `/use-cache-handle-lazy/${shape}?probe=${uniqueProbe()}`,
      );
      const first = await (
        await request.get(url, { headers: visitor("alice") })
      ).text();
      // Let the first request's background store write land.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const second = await (
        await request.get(url, { headers: visitor("bob") })
      ).text();

      expect(second).toContain("uchl-slow-leaf");
      expect(second).not.toContain("alice");
      expect(first).toContain("uchl-slow-leaf");
      expect(first).not.toContain("=alice");
    });
  }

  test("/plain: lazy state reading nothing request-scoped is stored and replayed", async ({
    request,
  }) => {
    const url = f.url(`/use-cache-handle-lazy/plain?probe=${uniqueProbe()}`);
    const served = async (name: string) => {
      const res = await request.get(url, { headers: visitor(name) });
      expect(res.status()).toBe(200);
      return res.text();
    };
    const first = await served("alice");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const second = await served("bob");

    for (const html of [first, second]) {
      expect(html).toContain("uchl-plain-lazy");
      expect(html).toContain("uchl-plain-thenable");
    }
    const stamp = (html: string) => /uchl-plain@([\d.-]+)/.exec(html)?.[1];
    expect(stamp(first)).toBeDefined();
    expect(stamp(second)).toBe(stamp(first));
  });
}

test.describe("use cache handle lazy", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  runUseCacheHandleLazySpec(f);
});

test.describe("use cache handle lazy (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  runUseCacheHandleLazySpec(f);
});
