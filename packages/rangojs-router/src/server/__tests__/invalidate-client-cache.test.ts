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
  if (opts.inbound) headers["X-Rango-State"] = opts.inbound;
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
