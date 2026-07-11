import { describe, it, expect } from "vitest";
import {
  resolveHostRouterHandlers,
  formatNoRoutersError,
  describeDiscoveryFailure,
  DiscoveryError,
  type CaughtDiscoveryError,
} from "../discovery-errors";

type Kind = "handler" | "lazy";
type TestRoute = { handler: unknown; kind: Kind };

function lazy(handler: (...args: any[]) => unknown): TestRoute {
  return { handler, kind: "lazy" };
}
function inline(handler: (...args: any[]) => unknown): TestRoute {
  return { handler, kind: "handler" };
}
function hostEntry(routes: TestRoute[], fallback?: TestRoute) {
  return { routes, fallback: fallback ?? null };
}

describe("resolveHostRouterHandlers", () => {
  it("invokes lazy mounts and never invokes inline (.map) handlers", async () => {
    const calls: string[] = [];
    const registry = new Map([
      [
        "app",
        hostEntry(
          [
            lazy(() => {
              calls.push("lazy-1");
              return Promise.resolve({ default: () => {} });
            }),
            // Inline handler: declares request, registers no routers. Must not
            // be invoked during discovery (it would crash on the missing
            // Request, and it is not a module mount).
            inline((request: Request) => {
              calls.push("inline");
              return new URL(request.url);
            }),
          ],
          lazy(() => {
            calls.push("fallback-lazy");
            return Promise.resolve({ default: () => {} });
          }),
        ),
      ],
    ]);

    const errors = await resolveHostRouterHandlers(registry);

    expect(calls).toEqual(["lazy-1", "fallback-lazy"]);
    expect(errors).toEqual([]);
  });

  it("collects a lazy mount rejection, tagged by host id", async () => {
    // A failed import surfaces as a rejected promise.
    const registry = new Map([
      [
        "broken-app",
        hostEntry([
          lazy(() =>
            Promise.reject(new Error("Cannot find module './broken'")),
          ),
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

  it("collects a lazy mount synchronous throw (e.g. a guard before import)", async () => {
    // Because the entry is tagged lazy, ANY failure is real - a synchronous
    // throw (a guard that runs before `import()`) is collected just like a
    // rejection. No arity heuristic is involved.
    const registry = new Map([
      [
        "app",
        hostEntry([
          lazy(() => {
            throw new Error("SUB_APP is required");
          }),
        ]),
      ],
    ]);

    const errors = await resolveHostRouterHandlers(registry);

    expect(errors).toHaveLength(1);
    expect(errors[0].context).toBe('host "app" route handler');
    expect((errors[0].error as Error).message).toBe("SUB_APP is required");
  });

  it("captures lazy fallback failures", async () => {
    const registry = new Map([
      [
        "app",
        hostEntry(
          [lazy(() => Promise.resolve({ default: () => {} }))],
          lazy(() => Promise.reject(new Error("fallback boom"))),
        ),
      ],
    ]);

    const errors = await resolveHostRouterHandlers(registry);

    expect(errors).toHaveLength(1);
    expect(errors[0].context).toBe('host "app" fallback handler');
    expect((errors[0].error as Error).message).toBe("fallback boom");
  });

  it("continues resolving after a failure (one bad mount does not stop the rest)", async () => {
    const calls: string[] = [];
    const registry = new Map([
      [
        "app",
        hostEntry([
          lazy(() => Promise.reject(new Error("first failed"))),
          lazy(() => {
            calls.push("second-ran");
            return Promise.resolve({ default: () => {} });
          }),
        ]),
      ],
    ]);

    const errors = await resolveHostRouterHandlers(registry);

    expect(calls).toEqual(["second-ran"]);
    expect(errors).toHaveLength(1);
  });

  it("does not invoke a param-declaring inline handler even if it would throw", async () => {
    let invoked = false;
    // The reported `*.*/admin` shape: an inline `(request) => ...` handler.
    // Tagged `.map()`, so discovery never invokes it - no false positive, no
    // crash on the missing Request.
    const registry = new Map([
      [
        "app",
        hostEntry([
          inline((request: Request) => {
            invoked = true;
            return new URL(request.url);
          }),
        ]),
      ],
    ]);

    const errors = await resolveHostRouterHandlers(registry);

    expect(invoked).toBe(false);
    expect(errors).toEqual([]);
  });

  it("invokes a param-declaring lazy mount (arity is irrelevant once tagged)", async () => {
    let imported = false;
    // A lazy loader may declare an ignored optional param,
    // `.lazy((_request?: Request) => import("./app"))`. The tag - not arity -
    // decides invocation, so it is still imported.
    const lazyWithParam = (_request?: Request) => {
      imported = true;
      return Promise.resolve({ default: () => {} });
    };
    expect(lazyWithParam.length).toBe(1);
    const registry = new Map([["app", hostEntry([lazy(lazyWithParam)])]]);

    const errors = await resolveHostRouterHandlers(registry);

    expect(imported).toBe(true);
    expect(errors).toEqual([]);
  });

  it("skips entries whose handler is not a function", async () => {
    const registry = new Map([
      [
        "app",
        { routes: [{ handler: undefined, kind: "lazy" }], fallback: null },
      ],
    ]);

    const errors = await resolveHostRouterHandlers(registry);

    expect(errors).toEqual([]);
  });
});

describe("formatNoRoutersError", () => {
  it("returns the bare message when there are no aggregated errors", () => {
    const msg = formatNoRoutersError("/app/router.tsx", []);
    expect(msg).toBe(
      "[rango] No routers found in registry after importing /app/router.tsx",
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
      "[rango] No routers found in registry after importing /app/worker.tsx",
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
      "[rango] No routers found in registry after importing /app/worker.tsx",
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
      "[rango] No routers found in registry after importing /app/router.tsx",
    );
  });
});

describe("describeDiscoveryFailure", () => {
  it("genuine empty registry (no reoptimize) is a loud, actionable error", () => {
    const err = new DiscoveryError("/app/router.tsx", []);

    const report = describeDiscoveryFailure(err, { reoptimizeObserved: false });

    expect(report.level).toBe("error");
    // The pinned base message is preserved so message-matching callers/tests
    // and the Vite overlay keep working.
    expect(report.message).toContain(
      "[rango] No routers found in registry after importing /app/router.tsx",
    );
    // ...plus an actionable next step.
    expect(report.message).toContain("createRouter()");
    // Not framed as transient.
    expect(report.message).not.toContain("re-optimizing");
  });

  it("empty registry during a re-optimization is a downgraded, transient warning", () => {
    const err = new DiscoveryError("/app/router.tsx", []);

    const report = describeDiscoveryFailure(err, { reoptimizeObserved: true });

    expect(report.level).toBe("warn");
    expect(report.message).toContain("re-optimizing dependencies");
    expect(report.message).toContain("transient");
    // Still points at the entry so a real misconfig is not fully hidden.
    expect(report.message).toContain("/app/router.tsx");
    expect(report.message).toContain("createRouter()");
  });

  it("host-handler failures stay loud even when a reoptimize was observed", () => {
    // caught.length > 0 means a concrete cause was captured: never downgrade.
    const err = new DiscoveryError("/app/worker.tsx", [
      {
        context: 'host "shop" route handler',
        error: new Error("Cannot find module './broken-sub-app'"),
      },
    ]);

    const report = describeDiscoveryFailure(err, { reoptimizeObserved: true });

    expect(report.level).toBe("error");
    expect(report.message).toContain("Cannot find module './broken-sub-app'");
  });

  it("non-DiscoveryError failures are reported loudly with their detail", () => {
    const err = new Error("acquireBuildEnv exploded");

    const report = describeDiscoveryFailure(err);

    expect(report.level).toBe("error");
    expect(report.message).toContain("Router discovery failed");
    expect(report.message).toContain("acquireBuildEnv exploded");
  });

  it("defaults reoptimizeObserved to false (loud) when omitted", () => {
    const err = new DiscoveryError("/app/router.tsx", []);

    const report = describeDiscoveryFailure(err);

    expect(report.level).toBe("error");
  });
});
