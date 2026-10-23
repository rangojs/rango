import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { isFileOutsideApp } from "../discovery/dev-server-phase.js";

const ROOT = join("/", "work", "app");

// A fake RSC module graph holding modules for the given absolute files.
function graphWith(...loaded: string[]) {
  const lookups: string[] = [];
  return {
    lookups,
    getModulesByFile(file: string) {
      lookups.push(file);
      return loaded.includes(file) ? new Set([{}]) : undefined;
    },
  };
}

describe("isFileOutsideApp", () => {
  const nested = join(ROOT, ".cache-version-work", "src", "router.tsx");

  it("skips a file in a skipped directory the graph has not loaded", () => {
    expect(isFileOutsideApp(ROOT, nested, graphWith())).toBe(true);
  });

  it("skips it when the graph holds an empty module set for it", () => {
    const graph = { getModulesByFile: () => new Set<unknown>() };
    expect(isFileOutsideApp(ROOT, nested, graph)).toBe(true);
  });

  it("skips it when there is no RSC graph yet", () => {
    expect(isFileOutsideApp(ROOT, nested, undefined)).toBe(true);
  });

  it("keeps a file in a skipped directory the graph has loaded", () => {
    const graph = graphWith(nested);
    expect(isFileOutsideApp(ROOT, nested, graph)).toBe(false);
    expect(graph.lookups).toEqual([nested]);
  });

  it("never skips a file outside the skipped directories", () => {
    const graph = graphWith();
    for (const rel of [
      "src/urls.tsx",
      "router.tsx",
      "src/build/urls.tsx",
      "src/__tests__/urls.tsx",
    ]) {
      expect(isFileOutsideApp(ROOT, join(ROOT, rel), graph), rel).toBe(false);
    }
    expect(graph.lookups).toEqual([]);
  });
});
