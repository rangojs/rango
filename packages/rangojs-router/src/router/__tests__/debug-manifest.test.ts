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

  it("rejects Promise<Array> with clear error", async () => {
    const entry = makeEntry((() =>
      Promise.resolve([
        { type: "route", name: "/c" },
      ])) as unknown as RouteEntry["handler"]);

    await expect(buildDebugManifest([entry])).rejects.toThrow(
      /Unsupported async handler result/,
    );
  });

  it("rejects Promise<string> with clear error", async () => {
    const entry = makeEntry((() =>
      Promise.resolve(
        "not a valid handler",
      )) as unknown as RouteEntry["handler"]);

    await expect(buildDebugManifest([entry])).rejects.toThrow(
      /Unsupported async handler result/,
    );
  });
});
