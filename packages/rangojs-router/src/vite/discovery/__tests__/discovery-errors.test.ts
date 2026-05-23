import { describe, it, expect } from "vitest";
import {
  resolveHostRouterHandlers,
  formatNoRoutersError,
  DiscoveryError,
  type CaughtDiscoveryError,
} from "../discovery-errors";

function hostEntry(
  routeHandlers: Array<(...args: any[]) => unknown>,
  fallbackHandler?: (...args: any[]) => unknown,
) {
  return {
    routes: routeHandlers.map((handler) => ({ handler })),
    fallback: fallbackHandler ? { handler: fallbackHandler } : null,
  };
}

describe("resolveHostRouterHandlers", () => {
  it("invokes every route and fallback handler", async () => {
    const calls: string[] = [];
    const registry = new Map([
      [
        "app",
        hostEntry(
          [() => calls.push("route-1"), () => calls.push("route-2")],
          () => calls.push("fallback"),
        ),
      ],
    ]);

    const errors = await resolveHostRouterHandlers(registry);

    expect(calls).toEqual(["route-1", "route-2", "fallback"]);
    expect(errors).toEqual([]);
  });

  it("collects handler failures instead of throwing, tagged by host id", async () => {
    // A real lazy import failure surfaces as a rejected promise (`() =>
    // import("./broken")` returns a rejecting thenable, it does not throw
    // synchronously), so that is the shape modeled here.
    const registry = new Map([
      [
        "broken-app",
        hostEntry([
          () => Promise.reject(new Error("Cannot find module './broken'")),
        ]),
      ],
    ]);

    const errors = await resolveHostRouterHandlers(registry);

    expect(errors).toHaveLength(1);
    expect(errors[0].context).toBe('host "broken-app" route handler');
    expect((errors[0].error as Error).message).toBe(
      "Cannot find module './broken'",
    );
  });

  it("captures fallback handler failures", async () => {
    const registry = new Map([
      [
        "app",
        hostEntry([() => undefined], () =>
          Promise.reject(new Error("fallback boom")),
        ),
      ],
    ]);

    const errors = await resolveHostRouterHandlers(registry);

    expect(errors).toHaveLength(1);
    expect(errors[0].context).toBe('host "app" fallback handler');
    expect((errors[0].error as Error).message).toBe("fallback boom");
  });

  it("continues resolving after a failure (one bad handler does not stop the rest)", async () => {
    const calls: string[] = [];
    const registry = new Map([
      [
        "app",
        hostEntry([
          () => Promise.reject(new Error("first failed")),
          () => calls.push("second-ran"),
        ]),
      ],
    ]);

    const errors = await resolveHostRouterHandlers(registry);

    expect(calls).toEqual(["second-ran"]);
    expect(errors).toHaveLength(1);
  });

  it("skips entries whose handler is not a function", async () => {
    const registry = new Map([
      ["app", { routes: [{ handler: undefined }], fallback: null }],
    ]);

    const errors = await resolveHostRouterHandlers(registry);

    expect(errors).toEqual([]);
  });

  it("does not collect a synchronously-throwing declared-param (inline) handler", async () => {
    let invoked = false;
    // Shape of a host pattern mapped to an inline handler:
    //   hostRouter.host("...").map((request) => new URL(request.url))
    // Discovery has no Request to pass, so invoking it argument-less throws on
    // `undefined.url`. The declared param marks it as an inline request handler
    // crashing on the missing Request, so the synchronous throw is ignored
    // rather than collected as an import failure.
    const inlineHandler = (request: Request) => {
      invoked = true;
      return new URL(request.url);
    };
    expect(inlineHandler.length).toBe(1);
    const registry = new Map([["app", hostEntry([inlineHandler])]]);

    const errors = await resolveHostRouterHandlers(registry);

    expect(invoked).toBe(true);
    expect(errors).toEqual([]);
  });

  it("collects a synchronously-throwing zero-arity lazy loader", async () => {
    // A valid LazyHandler can throw before its import() returns, e.g. a guard:
    //   hostRouter.host(["."]).map(() => {
    //     if (!process.env.SUB_APP) throw new Error("SUB_APP is required");
    //     return import(process.env.SUB_APP);
    //   });
    // Zero arity means there is no Request to dereference, so the throw is a
    // genuine loader failure - collected so the "no routers found" error keeps
    // the real cause (issue #501), not treated as an inline-handler crash.
    const lazyLoader = () => {
      throw new Error("SUB_APP is required");
    };
    expect(lazyLoader.length).toBe(0);
    const registry = new Map([["app", hostEntry([lazyLoader])]]);

    const errors = await resolveHostRouterHandlers(registry);

    expect(errors).toHaveLength(1);
    expect(errors[0].context).toBe('host "app" route handler');
    expect((errors[0].error as Error).message).toBe("SUB_APP is required");
  });

  it("does not let a crashing inline handler pollute errors while a lazy loader still resolves", async () => {
    const calls: string[] = [];
    // The reported case: an inline `(request) => ...` mapping sits next to a
    // lazy `() => import(...)` loader. The inline handler throws on the missing
    // Request (recognized and ignored); the loader resolves, and the error list
    // holds only real import failures (here: none).
    const inlineHandler = (request: Request) => new URL(request.url);
    const lazyLoader = () => {
      calls.push("loader");
      return Promise.resolve({ default: () => {} });
    };
    const registry = new Map([["app", hostEntry([inlineHandler, lazyLoader])]]);

    const errors = await resolveHostRouterHandlers(registry);

    expect(calls).toEqual(["loader"]);
    expect(errors).toEqual([]);
  });

  it("does not collect a synchronously-throwing inline fallback handler", async () => {
    const inlineFallback = (request: Request) => new URL(request.url);
    const registry = new Map([
      ["app", hostEntry([() => Promise.resolve()], inlineFallback)],
    ]);

    const errors = await resolveHostRouterHandlers(registry);

    expect(errors).toEqual([]);
  });

  it("invokes a param-declaring lazy loader and awaits its import (arity is not a gate)", async () => {
    let imported = false;
    // Valid LazyHandler shape that declares an ignored optional param:
    //   hostRouter.host(["."]).map((_request?: Request) => import("./app"))
    // The TS optional param compiles to a real JS parameter, so the function
    // has arity 1. It must still be invoked and awaited so the sub-app imports
    // and registers; gating on arity would skip it and leave "no routers".
    const lazyWithParam = (_request?: Request) => {
      imported = true;
      return Promise.resolve({ default: () => {} });
    };
    expect(lazyWithParam.length).toBe(1);
    const registry = new Map([["app", hostEntry([lazyWithParam])]]);

    const errors = await resolveHostRouterHandlers(registry);

    expect(imported).toBe(true);
    expect(errors).toEqual([]);
  });

  it("collects the rejection of a param-declaring lazy loader", async () => {
    // A param-declaring lazy loader whose import fails must still surface as a
    // real failure - arity must not suppress error collection either.
    const lazyWithParam = (_request?: Request) =>
      Promise.reject(new Error("Cannot find module './app'"));
    expect(lazyWithParam.length).toBe(1);
    const registry = new Map([["shop", hostEntry([lazyWithParam])]]);

    const errors = await resolveHostRouterHandlers(registry);

    expect(errors).toHaveLength(1);
    expect(errors[0].context).toBe('host "shop" route handler');
    expect((errors[0].error as Error).message).toBe(
      "Cannot find module './app'",
    );
  });

  it("awaits a thenable-returning lazy loader and collects its rejection", async () => {
    const registry = new Map([
      [
        "shop",
        hostEntry([
          () => Promise.reject(new Error("Cannot find module './sub-app'")),
        ]),
      ],
    ]);

    const errors = await resolveHostRouterHandlers(registry);

    expect(errors).toHaveLength(1);
    expect(errors[0].context).toBe('host "shop" route handler');
    expect((errors[0].error as Error).message).toBe(
      "Cannot find module './sub-app'",
    );
  });

  it("invokes a zero-arg handler but ignores a non-thenable return", async () => {
    let invoked = false;
    // A zero-arg inline handler that synchronously returns a Response is not a
    // module load: it is invoked, but a non-thenable result is not awaited and
    // produces no error.
    const registry = new Map([
      [
        "app",
        hostEntry([
          () => {
            invoked = true;
            return new Response("ok");
          },
        ]),
      ],
    ]);

    const errors = await resolveHostRouterHandlers(registry);

    expect(invoked).toBe(true);
    expect(errors).toEqual([]);
  });
});

describe("formatNoRoutersError", () => {
  it("returns the bare message when there are no aggregated errors", () => {
    const msg = formatNoRoutersError("/app/router.tsx", []);
    expect(msg).toBe(
      "[rsc-router] No routers found in registry after importing /app/router.tsx",
    );
  });

  it("surfaces the previously-swallowed error so the real cause is visible", () => {
    const error = new Error("Cannot find module './broken-sub-app'");
    const errors: CaughtDiscoveryError[] = [
      { context: 'host "shop" route handler', error },
    ];

    const msg = formatNoRoutersError("/app/worker.tsx", errors);

    // Base message is preserved for callers that match on it.
    expect(msg).toContain(
      "[rsc-router] No routers found in registry after importing /app/worker.tsx",
    );
    // The real import error and its location are now included.
    expect(msg).toContain("Cannot find module './broken-sub-app'");
    expect(msg).toContain('while resolving host "shop" route handler');
    expect(msg).toContain(
      "1 error(s) were caught during host-router discovery",
    );
  });

  it("includes the stack when the error provides one", () => {
    const error = new Error("import failed");
    const msg = formatNoRoutersError("/app/worker.tsx", [
      { context: 'host "x" route handler', error },
    ]);
    // Error.stack begins with "Error: import failed" then frames.
    expect(msg).toContain(error.stack!.split("\n")[0]);
  });

  it("aggregates multiple errors", () => {
    const errors: CaughtDiscoveryError[] = [
      { context: 'host "a" route handler', error: new Error("a failed") },
      { context: 'host "b" fallback handler', error: new Error("b failed") },
    ];

    const msg = formatNoRoutersError("/app/worker.tsx", errors);

    expect(msg).toContain("2 error(s) were caught");
    expect(msg).toContain("a failed");
    expect(msg).toContain("b failed");
  });

  it("handles non-Error thrown values", () => {
    const errors: CaughtDiscoveryError[] = [
      { context: "host-router discovery", error: "string failure" },
    ];

    const msg = formatNoRoutersError("/app/worker.tsx", errors);

    expect(msg).toContain("string failure");
  });
});

describe("DiscoveryError", () => {
  it("is an Error whose message carries the formatted detail", () => {
    const underlying = new Error("Cannot find module './broken-sub-app'");
    const err = new DiscoveryError("/app/worker.tsx", [
      { context: 'host "shop" route handler', error: underlying },
    ]);

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DiscoveryError);
    expect(err.name).toBe("DiscoveryError");
    // message-based callers (dev/HMR/build) still see the underlying cause.
    expect(err.message).toContain(
      "[rsc-router] No routers found in registry after importing /app/worker.tsx",
    );
    expect(err.message).toContain("Cannot find module './broken-sub-app'");
  });

  it("exposes the entry path and the caught failures", () => {
    const caught: CaughtDiscoveryError[] = [
      { context: 'host "shop" route handler', error: new Error("boom") },
    ];
    const err = new DiscoveryError("/app/worker.tsx", caught);

    expect(err.entryPath).toBe("/app/worker.tsx");
    expect(err.caught).toBe(caught);
  });

  it("sets cause to the single underlying error", () => {
    const underlying = new Error("import failed");
    const err = new DiscoveryError("/app/worker.tsx", [
      { context: 'host "x" route handler', error: underlying },
    ]);

    expect(err.cause).toBe(underlying);
  });

  it("wraps multiple failures in an AggregateError cause", () => {
    const a = new Error("a failed");
    const b = new Error("b failed");
    const err = new DiscoveryError("/app/worker.tsx", [
      { context: 'host "a" route handler', error: a },
      { context: 'host "b" fallback handler', error: b },
    ]);

    expect(err.cause).toBeInstanceOf(AggregateError);
    expect((err.cause as AggregateError).errors).toEqual([a, b]);
  });

  it("has no cause when nothing was caught", () => {
    const err = new DiscoveryError("/app/router.tsx", []);

    expect(err.cause).toBeUndefined();
    expect(err.message).toBe(
      "[rsc-router] No routers found in registry after importing /app/router.tsx",
    );
  });
});
