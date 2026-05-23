import { describe, it, expect } from "vitest";
import {
  resolveHostRouterHandlers,
  formatNoRoutersError,
  DiscoveryError,
  type CaughtDiscoveryError,
} from "../discovery-errors";

function hostEntry(
  routeHandlers: Array<() => unknown | Promise<unknown>>,
  fallbackHandler?: () => unknown | Promise<unknown>,
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
    const registry = new Map([
      [
        "broken-app",
        hostEntry([
          () => {
            throw new Error("Cannot find module './broken'");
          },
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
        hostEntry([() => undefined], () => {
          throw new Error("fallback boom");
        }),
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
          () => {
            throw new Error("first failed");
          },
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
