import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

// Issue #925: a "use cache" function reading a { cache: false } var through
// getRequestContext().get() throws, so no caller is served another caller's
// value (pages/use-cache-non-cacheable.tsx). The route's errorBoundary renders
// it; dev also pins the message.

function defineUseCacheNonCacheableTests(f: Fixture, production: boolean) {
  test('a { cache: false } var read inside "use cache" renders the error boundary for every caller', async ({
    request,
  }) => {
    for (const tenant of ["a", "b"]) {
      const res = await request.get(
        f.url(`/use-cache-non-cacheable?tenant=${tenant}`),
        { headers: { Accept: "text/html" } },
      );
      const html = await res.text();
      expect(html).toContain('data-testid="use-cache-non-cacheable-error"');
      expect(html).not.toContain('data-testid="use-cache-non-cacheable-value"');
      if (!production) expect(html).toContain("&quot;use cache&quot; function");
    }
  });
}

test.describe("use cache non-cacheable var (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  defineUseCacheNonCacheableTests(f, false);
});

test.describe("use cache non-cacheable var (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  defineUseCacheNonCacheableTests(f, true);
});
