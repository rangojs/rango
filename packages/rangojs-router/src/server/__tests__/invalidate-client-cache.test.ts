/**
 * Server seat of invalidateClientCache(): writes one rotated Set-Cookie for the
 * responding client, idempotent within a request, inert outside one, and
 * guarded inside a cache boundary.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRequestContext,
  runWithRequestContext,
} from "../request-context.js";
import { invalidateClientCache } from "../cookie-store.js";
import { INSIDE_CACHE_EXEC } from "../../cache/taint.js";

function makeCtx(
  opts: {
    stateCookieName?: string;
    version?: string;
    inbound?: string;
    cookie?: string;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.inbound !== undefined) headers["X-Rango-State"] = opts.inbound;
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  return createRequestContext({
    env: {},
    request: new Request("https://example.com", { headers }),
    url: new URL("https://example.com"),
    variables: {},
    stateCookieName: opts.stateCookieName,
    version: opts.version,
  });
}

const setCookies = (ctx: ReturnType<typeof makeCtx>): string[] =>
  ctx.res.headers.getSetCookie();

describe("invalidateClientCache() (server seat)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is an inert no-op outside a request context", () => {
    expect(() => invalidateClientCache()).not.toThrow();
  });

  it("writes one rotated Set-Cookie with a literal-colon value", () => {
    const ctx = makeCtx({
      stateCookieName: "rango-state_router_0",
      version: "v1",
    });
    vi.spyOn(Date, "now").mockReturnValue(1234);
    runWithRequestContext(ctx, () => invalidateClientCache());

    expect(setCookies(ctx)).toEqual([
      "rango-state_router_0=v1:1234; Path=/; SameSite=Lax; Secure",
    ]);
  });

  it("is idempotent within a request (one Set-Cookie regardless of call count)", () => {
    const ctx = makeCtx({
      stateCookieName: "rango-state_router_0",
      version: "v1",
    });
    runWithRequestContext(ctx, () => {
      invalidateClientCache();
      invalidateClientCache();
      invalidateClientCache();
    });

    expect(setCookies(ctx)).toHaveLength(1);
  });

  it("mints a timestamp strictly greater than the inbound client value", () => {
    const ctx = makeCtx({
      stateCookieName: "rango-state_router_0",
      version: "v1",
      inbound: "v1:1000",
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
    const ctx = makeCtx({
      stateCookieName: "rango-state_router_0",
      version: "v1",
      cookie: "rango-state_router_0=v1:1000",
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
    const ctx = makeCtx({
      stateCookieName: "rango-state_router_0",
      version: "v1",
      inbound: "",
      cookie: "rango-state_router_0=v1:1000",
    });
    vi.spyOn(Date, "now").mockReturnValue(500); // behind the client
    runWithRequestContext(ctx, () => invalidateClientCache());

    expect(setCookies(ctx)).toEqual([
      "rango-state_router_0=v1:1001; Path=/; SameSite=Lax; Secure",
    ]);
  });

  it("treats an empty rango-state cookie as absent (no usable prior value)", () => {
    const ctx = makeCtx({
      stateCookieName: "rango-state_router_0",
      version: "v1",
      cookie: "rango-state_router_0=",
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
    const ctx = makeCtx({
      stateCookieName: "rango-state_router_0",
      version: "a:b",
      cookie: "rango-state_router_0=a%3Ab:1000",
    });
    vi.spyOn(Date, "now").mockReturnValue(500); // behind the client
    runWithRequestContext(ctx, () => invalidateClientCache());

    expect(setCookies(ctx)).toEqual([
      "rango-state_router_0=a%3Ab:1001; Path=/; SameSite=Lax; Secure",
    ]);
  });

  it("does nothing when no resolved cookie name is available", () => {
    const ctx = makeCtx({ version: "v1" });
    runWithRequestContext(ctx, () => invalidateClientCache());

    expect(setCookies(ctx)).toHaveLength(0);
  });

  it("throws inside a cache-exec boundary (the cookies() guard)", () => {
    const ctx = makeCtx({
      stateCookieName: "rango-state_router_0",
      version: "v1",
    });
    (ctx as unknown as Record<symbol, unknown>)[INSIDE_CACHE_EXEC] = true;
    runWithRequestContext(ctx, () => {
      expect(() => invalidateClientCache()).toThrow(/use cache/);
    });
  });
});
