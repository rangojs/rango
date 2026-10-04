import { describe, it, expect } from "vitest";
import { buildDebugManifest } from "../debug-manifest.js";
import { urls } from "../../urls.js";
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

  it("rejects Promise<{ default: nonFunction }> with clear error", async () => {
    const entry = makeEntry((() =>
      Promise.resolve({
        default: [{ type: "route" }],
      })) as unknown as RouteEntry["handler"]);

    await expect(buildDebugManifest([entry])).rejects.toThrow(
      /\{ default \} must be a function/,
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

describe("buildDebugManifest lazy include placeholders", () => {
  // A lazy placeholder carries the parent urls() handler; it must not re-run
  // into the shared manifest.
  it("lists the mount's routes once and does not expand include() children", async () => {
    const blog = urls<any>(({ path }) => [
      path("/", handler, { name: "index" }),
    ]);
    const root = urls<any>(({ path, include }) => [
      path("/", handler, { name: "home" }),
      include("/blog", blog, { name: "blog" }),
    ]);
    const placeholder: RouteEntry = {
      ...makeEntry(root.handler, 1),
      staticPrefix: "/blog",
      lazy: true,
      lazyPatterns: blog,
      lazyEvaluated: false,
    };

    const manifest = await buildDebugManifest([
      placeholder,
      makeEntry(root.handler, 0),
    ]);

    expect(Object.keys(manifest.routes)).toEqual(["home"]);
    expect(manifest.routes.home?.shortCode).toBe("M0L0R0");
    expect(Object.keys(manifest.layouts)).toEqual(["debug.M0.$root"]);
  });
});
