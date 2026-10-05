/**
 * captureRequestEntryContext (request-context.ts): the async context a
 * request entered the handler with, kept so router.prerender() can dispatch a
 * warm outside the scopes of the code that called it
 * (RequestContext._runAtRequestEntry, read in router.ts). The end-to-end
 * proof, a warm called from a route handler, is in
 * testing/__tests__/prerender-warm-layers.rsc-test.tsx.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _getRequestContext,
  captureRequestEntryContext,
  createRequestContext,
  runWithRequestContext,
} from "../request-context.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("captureRequestEntryContext", () => {
  it("runs a callback in the context it was captured in, not the caller's", () => {
    const scope = new AsyncLocalStorage<string>();
    const atEntry = scope.run("entry", () => captureRequestEntryContext())!;

    const seen = scope.run("handler", () => atEntry(() => scope.getStore()));

    expect(seen).toBe("entry");
  });

  it("captured before any scope, it leaves the request context the caller is in", () => {
    const atEntry = captureRequestEntryContext()!;
    const url = new URL("https://shop.example/trigger");
    const ctx = createRequestContext({
      env: {},
      request: new Request(url),
      url,
      variables: {},
    });

    runWithRequestContext(ctx, () => {
      expect(_getRequestContext()).toBe(ctx);
      expect(atEntry(() => _getRequestContext())).toBeUndefined();
      // The caller's own context is untouched afterwards.
      expect(_getRequestContext()).toBe(ctx);
    });
  });

  it("keeps the captured context across the callback's awaits", async () => {
    const scope = new AsyncLocalStorage<string>();
    const atEntry = scope.run("entry", () => captureRequestEntryContext())!;

    const seen = await scope.run("handler", () =>
      atEntry(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return scope.getStore();
      }),
    );

    expect(seen).toBe("entry");
  });

  it("answers undefined where the runtime has no AsyncLocalStorage.snapshot", () => {
    vi.spyOn(AsyncLocalStorage, "snapshot", "get").mockReturnValue(
      undefined as never,
    );

    expect(captureRequestEntryContext()).toBeUndefined();
  });
});
