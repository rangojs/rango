/**
 * Server seat of keepClientCache(): sets the internal directive header the
 * action bridge reads, idempotent within a request, inert outside one, guarded
 * inside a cache boundary.
 */
import { describe, expect, it } from "vitest";
import {
  createRequestContext,
  runWithRequestContext,
} from "../request-context.js";
import { keepClientCache } from "../cookie-store.js";
import { INSIDE_CACHE_EXEC } from "../../cache/taint.js";

function makeCtx() {
  return createRequestContext({
    env: {},
    request: new Request("https://example.com"),
    url: new URL("https://example.com"),
    variables: {},
  });
}

const directive = (ctx: ReturnType<typeof makeCtx>): string | null =>
  ctx.res.headers.get("x-rango-keep-cache");

describe("keepClientCache() (server seat)", () => {
  it("is an inert no-op outside a request context", () => {
    expect(() => keepClientCache()).not.toThrow();
  });

  it("sets the directive header", () => {
    const ctx = makeCtx();
    runWithRequestContext(ctx, () => keepClientCache());
    expect(directive(ctx)).toBe("1");
  });

  it("is idempotent within a request (one header regardless of call count)", () => {
    const ctx = makeCtx();
    runWithRequestContext(ctx, () => {
      keepClientCache();
      keepClientCache();
      keepClientCache();
    });
    // `.set` keeps a single header; getSetCookie is unrelated, so assert the
    // header value is the single "1".
    expect(directive(ctx)).toBe("1");
    expect(ctx.res.headers.get("x-rango-keep-cache")).toBe("1");
  });

  it("throws inside a cache-exec boundary (the cookies() guard)", () => {
    const ctx = makeCtx();
    (ctx as unknown as Record<symbol, unknown>)[INSIDE_CACHE_EXEC] = true;
    runWithRequestContext(ctx, () => {
      expect(() => keepClientCache()).toThrow(/use cache/);
    });
  });
});
