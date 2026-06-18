import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// B3: per-scan readFileSync/parse memo. Wrap node:fs readFileSync with a
// pass-through counter so we can assert a shared include target is read from
// disk once per scan, not once per mount. `vi.spyOn` cannot be used here: the
// node:fs namespace is non-configurable in ESM. The factory delegates to the
// real fs for every call, so behavior is unchanged — only counted.
const readCounts: Record<string, number> = {};
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (p: unknown, ...rest: unknown[]) => {
      readCounts[String(p)] = (readCounts[String(p)] ?? 0) + 1;
      return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    },
  };
});

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { writePerModuleRouteTypesForFile } from "../generate-route-types";

function countSharedReads(absPath: string): number {
  const r = resolve(absPath);
  return (
    (readCounts[absPath] ?? 0) + (r !== absPath ? (readCounts[r] ?? 0) : 0)
  );
}

describe("include-resolution per-scan read memo", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "include-memo-test-"));
    for (const k of Object.keys(readCounts)) delete readCounts[k];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads a doubly-mounted shared include from disk once per scan", () => {
    const sharedPath = join(tempDir, "shared-urls.ts");
    writeFileSync(
      sharedPath,
      `import { urls } from "@rangojs/router";
const handler = () => null;
export const sharedUrls = urls(({ path }) => [
  path("/health", handler, { name: "health" }),
  path("/:id", handler, { name: "detail" }),
]);
`,
    );

    const mainPath = join(tempDir, "urls.ts");
    writeFileSync(
      mainPath,
      `import { urls } from "@rangojs/router";
import { sharedUrls } from "./shared-urls.js";
const handler = () => null;
export const patterns = urls(({ path, include }) => [
  path("/", handler, { name: "home" }),
  include("/api", sharedUrls, { name: "api" }),
  include("/v2", sharedUrls, { name: "v2" }),
]);
`,
    );

    writePerModuleRouteTypesForFile(mainPath);

    // The shared module is mounted under two prefixes. Without the per-scan
    // memo it was read once per mount (2); with the memo it is read once.
    expect(countSharedReads(sharedPath)).toBe(1);
  });

  it("still produces the full route map for the doubly-mounted include", () => {
    // Behavior-preserving guard: memoized reads must not change output.
    const sharedPath = join(tempDir, "shared-urls.ts");
    writeFileSync(
      sharedPath,
      `import { urls } from "@rangojs/router";
const handler = () => null;
export const sharedUrls = urls(({ path }) => [
  path("/health", handler, { name: "health" }),
  path("/:id", handler, { name: "detail" }),
]);
`,
    );

    const mainPath = join(tempDir, "urls.ts");
    writeFileSync(
      mainPath,
      `import { urls } from "@rangojs/router";
import { sharedUrls } from "./shared-urls.js";
const handler = () => null;
export const patterns = urls(({ path, include }) => [
  path("/", handler, { name: "home" }),
  include("/api", sharedUrls, { name: "api" }),
  include("/v2", sharedUrls, { name: "v2" }),
]);
`,
    );

    // readFileSync is wrapped to count; reading back the gen file below uses
    // the same pass-through wrapper, which returns the real contents.
    writePerModuleRouteTypesForFile(mainPath);

    const genPath = mainPath.replace(/\.ts$/, ".gen.ts");
    const content = readFileSync(genPath, "utf-8");
    expect(content).toContain('"api.health"');
    expect(content).toContain('"/api/health"');
    expect(content).toContain('"v2.detail"');
    expect(content).toContain('"/v2/:id"');
  });
});
