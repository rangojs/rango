import { describe, it, expect } from "vitest";
import { buildDebugManifest } from "../debug-manifest.js";
import type { RouteEntry } from "../../types/route-entry.js";

const handler = () => null;

function makeEntry(
  entryHandler: RouteEntry["handler"],
  mountIndex = 0,
): RouteEntry {
  return {
    prefix: "",
    staticPrefix: "",
    routes: {} as RouteEntry["routes"],
    handler: entryHandler,
    mountIndex,
  };
}

describe("buildDebugManifest async handler shapes", () => {
  it("handles Promise<{ default: fn }> (dynamic import)", async () => {
    const entry = makeEntry((() =>
      Promise.resolve({
        default: (h: any) => [h.route("/a", handler)],
      })) as RouteEntry["handler"]);

    const manifest = await buildDebugManifest([entry]);
    expect(manifest.totalRoutes).toBeGreaterThanOrEqual(1);
    expect(Object.keys(manifest.routes)).toContain("/a");
  });

  it("handles Promise<fn>", async () => {
    const entry = makeEntry((() =>
      Promise.resolve((h: any) => [
        h.route("/b", handler),
      ])) as RouteEntry["handler"]);

    const manifest = await buildDebugManifest([entry]);
    expect(manifest.totalRoutes).toBeGreaterThanOrEqual(1);
    expect(Object.keys(manifest.routes)).toContain("/b");
  });

  it("handles genuinely async Promise<Array>", async () => {
    // When h.route() is called during async resolution inside runWithStore,
    // the ALS context is still active, so routes register as side effects.
    const entry = makeEntry((async () => {
      await Promise.resolve();
      const { createRouteHelpers } = await import("../../route-definition.js");
      const h: any = createRouteHelpers();
      return [h.route("/async-array", handler)];
    }) as unknown as RouteEntry["handler"]);

    const manifest = await buildDebugManifest([entry]);
    expect(Object.keys(manifest.routes)).toContain("/async-array");
  });

  it("Promise<fn> was previously dropped (regression)", async () => {
    // Before the fix, only Promise<{ default: fn }> was handled.
    // Promise<fn> would silently produce an empty manifest.
    const entry = makeEntry((() =>
      Promise.resolve((h: any) => [
        h.route("/x", handler),
        h.route("/y", handler),
      ])) as RouteEntry["handler"]);

    const manifest = await buildDebugManifest([entry]);
    expect(manifest.totalRoutes).toBe(2);
    expect(Object.keys(manifest.routes)).toEqual(
      expect.arrayContaining(["/x", "/y"]),
    );
  });
});
