import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";

// Regression repro for top-level (router.use) middleware that throws or
// returns a Response, running under miniflare/wrangler — the path that
// originally surfaced the bug for Cloudflare consumers. Pairs with the Node
// e2e at packages/rangojs-router/e2e/global-mw-response.test.ts: same
// shared composer (src/router/middleware.ts), different host.

function sharedTests(f: ReturnType<typeof useFixture>) {
  test("throw Response from global middleware short-circuits (not error)", async ({
    request,
  }) => {
    const response = await request.get(
      f.url("/__test/global-mw-throw-response"),
    );

    // Pre-fix, the throw escaped to miniflare and came back as an opaque 500.
    // With the composer-level fix, the thrown Response is control flow.
    expect(response.status()).toBe(418);
    expect(response.headers()["x-throw-response"]).toBe("applied");
    expect(await response.text()).toBe("throw-response-body");
  });

  test("return Response from global middleware short-circuits (sanity)", async ({
    request,
  }) => {
    const response = await request.get(
      f.url("/__test/global-mw-return-response"),
    );

    expect(response.status()).toBe(418);
    expect(response.headers()["x-return-response"]).toBe("applied");
    expect(await response.text()).toBe("return-response-body");
  });
}

test.describe("global middleware Response short-circuit (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  sharedTests(f);
});

test.describe("global middleware Response short-circuit (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  sharedTests(f);
});
