import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";

// Regression repro for: top-level (router.use) middleware that throws OR returns
// a Response. The RETURN path already short-circuits via middleware.ts:474.
// The THROW path is currently unhandled — it escapes rsc/handler.ts:478
// `executeMiddleware` (no try/catch for Response-as-control-flow) and gets
// stringified by the host (miniflare on Cloudflare, node adapter on Node) as
// an opaque 500. Design intent: a thrown Response should be treated as a
// short-circuit; only real Errors should reach onError.
//
// These tests run in dev AND production — the code path is shared across
// targets, so Node fixtures exercise the same executeMiddleware that CF
// miniflare routes through.

async function readErrorLog(
  request: import("@playwright/test").APIRequestContext,
  errorUrl: string,
): Promise<Array<{ phase: string; message: string }> | null> {
  const response = await request.get(errorUrl);
  const data = await response.json();
  return data;
}

function sharedTests(f: ReturnType<typeof useFixture>) {
  test("throw Response from global middleware should short-circuit (not error)", async ({
    request,
  }) => {
    await request.get(f.url("/__test/clear-error-log"));

    const response = await request.get(
      f.url("/__test/global-mw-throw-response"),
    );

    // The thrown Response carries status 418 and a marker header. If the host
    // swallows the throw, we see 500 with an opaque body instead.
    expect(response.status()).toBe(418);
    expect(response.headers()["x-throw-response"]).toBe("applied");
    expect(await response.text()).toBe("throw-response-body");

    // A Response short-circuit is control flow, not an error. onError must
    // not be invoked — there's no Error to report anyway.
    const log = await readErrorLog(request, f.url("/__test/last-error"));
    expect(log).toBeNull();
  });

  test("return Response from global middleware short-circuits (sanity)", async ({
    request,
  }) => {
    await request.get(f.url("/__test/clear-error-log"));

    const response = await request.get(
      f.url("/__test/global-mw-return-response"),
    );

    expect(response.status()).toBe(418);
    expect(response.headers()["x-return-response"]).toBe("applied");
    expect(await response.text()).toBe("return-response-body");

    const log = await readErrorLog(request, f.url("/__test/last-error"));
    expect(log).toBeNull();
  });
}

test.describe("global middleware Response short-circuit (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  sharedTests(f);
});

test.describe("global middleware Response short-circuit (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
    isolatedServer: true,
  });

  test.setTimeout(120000);

  sharedTests(f);
});
