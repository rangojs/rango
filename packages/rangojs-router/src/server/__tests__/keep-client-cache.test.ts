/**
 * Server seat of keepClientCache(): sets the internal directive header the
 * action bridge reads, idempotent within a request, inert outside one, guarded
 * inside a cache boundary.
 */
import { describe, expect, it } from "vitest";
import {
  runWithRequestContext,
  type RequestContext,
} from "../request-context.js";
import { makeRequestContext } from "../../__tests__/kit/request-context.js";
import { keepClientCache } from "../cookie-store.js";
import { runWithCacheExecScope } from "../../cache/cache-exec-scope.js";

const EXAMPLE_URL = "https://example.com";

const directive = (ctx: RequestContext): string | null =>
  ctx.res.headers.get("x-rango-keep-cache");

describe("keepClientCache() (server seat)", () => {
  it("is an inert no-op outside a request context", () => {
    expect(() => keepClientCache()).not.toThrow();
  });

  it("sets the directive header", () => {
    const ctx = makeRequestContext({ url: EXAMPLE_URL });
    runWithRequestContext(ctx, () => keepClientCache());
    expect(directive(ctx)).toBe("1");
  });

  it("is idempotent within a request (one header regardless of call count)", () => {
    const ctx = makeRequestContext({ url: EXAMPLE_URL });
    runWithRequestContext(ctx, () => {
      keepClientCache();
      keepClientCache();
      keepClientCache();
    });
    // `.set` (not `.append`) keeps a single header regardless of call count.
    expect(directive(ctx)).toBe("1");
  });

  it("throws inside a cache-exec boundary (the cookies() guard)", () => {
    const ctx = makeRequestContext({ url: EXAMPLE_URL });
    runWithRequestContext(ctx, () =>
      runWithCacheExecScope(() => {
        expect(() => keepClientCache()).toThrow(/use cache/);
      }),
    );
  });
});
