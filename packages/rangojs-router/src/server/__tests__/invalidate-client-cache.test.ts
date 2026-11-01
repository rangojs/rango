/**
 * Server seat of invalidateClientCache(): writes one rotated Set-Cookie for the
 * responding client, idempotent within a request, inert outside one, and
 * guarded inside a cache boundary.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runWithRequestContext,
  type RequestContext,
} from "../request-context.js";
import { makeRequestContext } from "../../__tests__/kit/request-context.js";
import {
  invalidateClientCache,
  keepClientCache,
  runActionBody,
} from "../cookie-store.js";
import { runWithCacheExecScope } from "../../cache/cache-exec-scope.js";
import { uniformVersions } from "../../router-versions.js";

const EXAMPLE_URL = "https://example.com";

const setCookies = (ctx: RequestContext): string[] =>
  ctx.res.headers.getSetCookie();

describe("invalidateClientCache() (server seat)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is an inert no-op outside a request context", () => {
    expect(() => invalidateClientCache()).not.toThrow();
  });

  it("writes one rotated Set-Cookie with a literal-colon value", () => {
    const ctx = makeRequestContext({
      url: EXAMPLE_URL,
      stateCookieName: "rango-state_router_0",
      versions: uniformVersions("v1"),
    });
    vi.spyOn(Date, "now").mockReturnValue(1234);
    runWithRequestContext(ctx, () => invalidateClientCache());

    expect(setCookies(ctx)).toEqual([
      "rango-state_router_0=v1:1234; Path=/; SameSite=Lax; Secure",
    ]);
  });

  it("is idempotent within a request (one Set-Cookie regardless of call count)", () => {
    const ctx = makeRequestContext({
      url: EXAMPLE_URL,
      stateCookieName: "rango-state_router_0",
      versions: uniformVersions("v1"),
    });
    runWithRequestContext(ctx, () => {
      invalidateClientCache();
      invalidateClientCache();
      invalidateClientCache();
    });

    expect(setCookies(ctx)).toHaveLength(1);
  });

  it("mints a timestamp strictly greater than the inbound client value", () => {
    const ctx = makeRequestContext({
      url: EXAMPLE_URL,
      stateCookieName: "rango-state_router_0",
      versions: uniformVersions("v1"),
      init: { headers: { "X-Rango-State": "v1:1000" } },
    });
    vi.spyOn(Date, "now").mockReturnValue(500); // server clock behind the client
    runWithRequestContext(ctx, () => invalidateClientCache());

    expect(setCookies(ctx)).toEqual([
      "rango-state_router_0=v1:1001; Path=/; SameSite=Lax; Secure",
    ]);
  });

  it("mints from the request cookie when the X-Rango-State header is absent", () => {
    // Action POSTs and plain app fetch()s carry no router header but DO send the
    // cookie; the monotonic guard must read it so the rotation can't collide.
    const ctx = makeRequestContext({
      url: EXAMPLE_URL,
      stateCookieName: "rango-state_router_0",
      versions: uniformVersions("v1"),
      init: { headers: { Cookie: "rango-state_router_0=v1:1000" } },
    });
    vi.spyOn(Date, "now").mockReturnValue(500); // behind the client
    runWithRequestContext(ctx, () => invalidateClientCache());

    expect(setCookies(ctx)).toEqual([
      "rango-state_router_0=v1:1001; Path=/; SameSite=Lax; Secure",
    ]);
  });

  it("falls back to the cookie when the X-Rango-State header is present but empty", () => {
    // Proxy normalization (or a client bug) can send an empty header. '' is not
    // nullish, so it must not short-circuit the cookie fallback — otherwise
    // prevTs falls to 0 on exactly the requests the fallback exists for.
    const ctx = makeRequestContext({
      url: EXAMPLE_URL,
      stateCookieName: "rango-state_router_0",
      versions: uniformVersions("v1"),
      init: {
        headers: {
          "X-Rango-State": "",
          Cookie: "rango-state_router_0=v1:1000",
        },
      },
    });
    vi.spyOn(Date, "now").mockReturnValue(500); // behind the client
    runWithRequestContext(ctx, () => invalidateClientCache());

    expect(setCookies(ctx)).toEqual([
      "rango-state_router_0=v1:1001; Path=/; SameSite=Lax; Secure",
    ]);
  });

  it("treats an empty rango-state cookie as absent (no usable prior value)", () => {
    const ctx = makeRequestContext({
      url: EXAMPLE_URL,
      stateCookieName: "rango-state_router_0",
      versions: uniformVersions("v1"),
      init: { headers: { Cookie: "rango-state_router_0=" } },
    });
    vi.spyOn(Date, "now").mockReturnValue(777);
    runWithRequestContext(ctx, () => invalidateClientCache());

    // No usable prior value -> prevTs floor 0 -> mints straight from Date.now().
    expect(setCookies(ctx)).toEqual([
      "rango-state_router_0=v1:777; Path=/; SameSite=Lax; Secure",
    ]);
  });

  it("reads a percent-encoded version from the cookie without double-decoding (monotonic guard holds)", () => {
    // The client writes the value as encodeURIComponent(version):timestamp, so a
    // version that encodes to a percent-escape ("a:b" -> "a%3Ab") arrives in the
    // Cookie header still escaped. The server must NOT route it through the
    // decoding cookie parser: decoding "a%3Ab:1000" to "a:b:1000" makes
    // decodeStateValue split on the wrong colon, prevTs falls to 0, and a server
    // clock behind the client mints a colliding timestamp the observer can't see.
    const ctx = makeRequestContext({
      url: EXAMPLE_URL,
      stateCookieName: "rango-state_router_0",
      versions: uniformVersions("a:b"),
      init: { headers: { Cookie: "rango-state_router_0=a%3Ab:1000" } },
    });
    vi.spyOn(Date, "now").mockReturnValue(500); // behind the client
    runWithRequestContext(ctx, () => invalidateClientCache());

    expect(setCookies(ctx)).toEqual([
      "rango-state_router_0=a%3Ab:1001; Path=/; SameSite=Lax; Secure",
    ]);
  });

  it("does nothing when no resolved cookie name is available", () => {
    const ctx = makeRequestContext({
      url: EXAMPLE_URL,
      versions: uniformVersions("v1"),
    });
    runWithRequestContext(ctx, () => invalidateClientCache());

    expect(setCookies(ctx)).toHaveLength(0);
  });

  it("throws inside a cache-exec boundary (the cookies() guard)", () => {
    const ctx = makeRequestContext({
      url: EXAMPLE_URL,
      stateCookieName: "rango-state_router_0",
      versions: uniformVersions("v1"),
    });
    runWithRequestContext(ctx, () =>
      runWithCacheExecScope(() => {
        expect(() => invalidateClientCache()).toThrow(/use cache/);
      }),
    );
  });
});

/**
 * A server action's body run through runActionBody: the response's state
 * Set-Cookie keeps the client's timestamp and bumps the write part, so the
 * browser HTTP cache misses on what it holds from before the write.
 */
describe("runActionBody: the write bump", () => {
  afterEach(() => vi.restoreAllMocks());

  const actionContext = (state: string | null) =>
    makeRequestContext({
      url: EXAMPLE_URL,
      stateCookieName: "rango-state_router_0",
      versions: uniformVersions("v1"),
      init: state
        ? { headers: { Cookie: `rango-state_router_0=${state}` } }
        : undefined,
    });

  it("bumps the write part and keeps the timestamp, however the body ends", async () => {
    vi.spyOn(Date, "now").mockReturnValue(5000);
    const ctx = actionContext("v1:1000");
    await runWithRequestContext(ctx, () => runActionBody(() => "done"));
    expect(setCookies(ctx)).toEqual([
      "rango-state_router_0=v1:1000:5000; Path=/; SameSite=Lax; Secure",
    ]);

    const thrown = actionContext("v1:1000:7000");
    await runWithRequestContext(thrown, () =>
      runActionBody(() => {
        throw new Error("boom");
      }).catch(() => {}),
    );
    expect(setCookies(thrown)).toEqual([
      "rango-state_router_0=v1:1000:7001; Path=/; SameSite=Lax; Secure",
    ]);
  });

  it("returns what the body returns", async () => {
    const ctx = actionContext("v1:1000");
    await expect(
      runWithRequestContext(ctx, () => runActionBody(async () => 42)),
    ).resolves.toBe(42);
  });

  it("bumps nothing after keepClientCache()", async () => {
    const ctx = actionContext("v1:1000");
    await runWithRequestContext(ctx, () =>
      runActionBody(() => keepClientCache()),
    );
    expect(setCookies(ctx)).toEqual([]);
  });

  it("invalidateClientCache() in the body rotates the timestamp, and no bump follows", async () => {
    vi.spyOn(Date, "now").mockReturnValue(5000);
    const ctx = actionContext("v1:1000:4000");
    await runWithRequestContext(ctx, () =>
      runActionBody(() => invalidateClientCache()),
    );
    expect(setCookies(ctx)).toEqual([
      "rango-state_router_0=v1:5000; Path=/; SameSite=Lax; Secure",
    ]);
  });

  it("a rotation after the bump (a loader of the revalidation) replaces its line", async () => {
    vi.spyOn(Date, "now").mockReturnValue(5000);
    const ctx = actionContext("v1:1000");
    await runWithRequestContext(ctx, async () => {
      ctx.setCookie("other", "1");
      await runActionBody(() => {});
      invalidateClientCache();
    });
    expect(setCookies(ctx)).toEqual([
      "other=1",
      "rango-state_router_0=v1:5000; Path=/; SameSite=Lax; Secure",
    ]);
  });

  it("writes nothing when the request carries no state", async () => {
    const ctx = actionContext(null);
    await runWithRequestContext(ctx, () => runActionBody(() => {}));
    expect(setCookies(ctx)).toEqual([]);
  });
});
