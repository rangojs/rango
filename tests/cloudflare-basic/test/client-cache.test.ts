import { describe, expect, it } from "vitest";
import { runInRequestContext } from "@rangojs/router/testing";
import {
  logoutAction,
  dismissBannerAction,
} from "../src/actions/client-cache.js";

// Dogfood the rango CLIENT-cache directives (invalidateClientCache /
// keepClientCache) through runInRequestContext against the app's REAL server
// actions. Proves a consumer can unit-assert both directives' observable output
// - the rotation `Set-Cookie` and the `x-rango-keep-cache` header - without an
// e2e. The state cookie name is seeded by the primitive (default
// `rango-state_router_0`), so invalidateClientCache() rotates exactly as in
// production rather than silently no-opping.
//
// Server-side cache TAG invalidation (updateTag) is unit-tested separately in
// cache-tags.test.ts - it IS unit-assertable against a MemorySegmentCacheStore.

const stateCookies = (res: Response) =>
  res.headers.getSetCookie().filter((c) => c.startsWith("rango-state_"));

describe("client-cache directives against cloudflare-basic actions", () => {
  it("logoutAction: clears the session AND rotates the state cookie (invalidateClientCache)", async () => {
    const { result, response } = await runInRequestContext(
      () => logoutAction(),
      {
        request: new Request("https://app.test/", {
          headers: { Cookie: "session=abc" },
        }),
      },
    );
    expect(result).toEqual({ ok: true });
    // invalidateClientCache() rotated the state cookie: one Set-Cookie, and the
    // https request carries the Secure attribute.
    const rotation = stateCookies(response);
    expect(rotation).toHaveLength(1);
    expect(rotation[0]).toMatch(/^rango-state_router_0=0:\d+;.*Secure$/);
    // The session cookie was cleared (a delete emits its own Set-Cookie).
    const setCookies = response.headers.getSetCookie();
    expect(setCookies.some((c) => c.startsWith("session="))).toBe(true);
  });

  it("dismissBannerAction: persists the cookie but keeps the client cache (keepClientCache)", async () => {
    const { result, headers, response, cookies } = await runInRequestContext(
      () => dismissBannerAction(),
    );
    expect(result).toEqual({ ok: true });
    // keepClientCache() set the suppression directive the action bridge reads...
    expect(headers["x-rango-keep-cache"]).toBe("1");
    // ...and did NOT rotate the state cookie.
    expect(stateCookies(response)).toHaveLength(0);
    // The banner choice was persisted.
    expect(cookies["banner-dismissed"]).toBe("1");
  });
});
