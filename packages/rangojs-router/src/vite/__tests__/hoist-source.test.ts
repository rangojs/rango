import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePath } from "vite";
import {
  loadEmittedOrDisk,
  readSource,
  recordEmitted,
  resolveSourceTarget,
  SOURCE_FILE_RE,
  type EmittedEntry,
} from "../plugins/hoist/source.js";

describe("SOURCE_FILE_RE", () => {
  it("matches script extensions of a path with the query already stripped", () => {
    for (const file of ["a.ts", "a.tsx", "a.js", "a.jsx", "a.mjs", "a.cts"]) {
      expect(SOURCE_FILE_RE.test(file), file).toBe(true);
    }
    for (const file of ["a.css", "a.tsx.map", "a.json", "a"]) {
      expect(SOURCE_FILE_RE.test(file), file).toBe(false);
    }
  });
});

describe("resolveSourceTarget", () => {
  const resolver = (id: string | null, external?: boolean) => ({
    resolve: async () => (id === null ? null : { id, external }),
  });
  const keep = { skipNodeModules: false };

  it("returns the resolved file without its query", async () => {
    expect(
      await resolveSourceTarget(
        resolver("/app/a.ts?v=1"),
        "./a",
        "/app/b.ts",
        keep,
      ),
    ).toBe("/app/a.ts");
  });

  it("returns null for an unresolved, external or virtual import", async () => {
    expect(
      await resolveSourceTarget(resolver(null), "x", "/app/b.ts", keep),
    ).toBeNull();
    expect(
      await resolveSourceTarget(resolver("x", true), "x", "/app/b.ts", keep),
    ).toBeNull();
    expect(
      await resolveSourceTarget(
        resolver("\0virtual:x"),
        "x",
        "/app/b.ts",
        keep,
      ),
    ).toBeNull();
  });

  it("skips a dependency only when asked to", async () => {
    const dep = resolver("/app/node_modules/lib/index.js");
    expect(
      await resolveSourceTarget(dep, "lib", "/app/b.ts", {
        skipNodeModules: true,
      }),
    ).toBeNull();
    expect(await resolveSourceTarget(dep, "lib", "/app/b.ts", keep)).toBe(
      "/app/node_modules/lib/index.js",
    );
  });
});

describe("loadEmittedOrDisk", () => {
  let dir: string;
  beforeAll(async () => {
    dir = normalizePath(await mkdtemp(join(tmpdir(), "rango-hoist-source-")));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const rehoist = async (disk: string): Promise<string> => `disk:${disk}`;

  it("serves the emission while the disk source is the one the transform saw", async () => {
    const file = `${dir}/seen.ts`;
    await writeFile(file, "one");
    const emitted = new Map<string, EmittedEntry<string>>();
    await recordEmitted(emitted, file, "emitted");
    expect(await loadEmittedOrDisk(emitted, file, rehoist)).toBe("emitted");
  });

  it("re-hoists the disk source once it changed, or when nothing was emitted", async () => {
    const file = `${dir}/edited.ts`;
    await writeFile(file, "one");
    const emitted = new Map<string, EmittedEntry<string>>();
    expect(await loadEmittedOrDisk(emitted, file, rehoist)).toBe("disk:one");
    await recordEmitted(emitted, file, "emitted");
    await writeFile(file, "two");
    expect(await loadEmittedOrDisk(emitted, file, rehoist)).toBe("disk:two");
  });

  it("serves the emission of a file that is gone and undefined when there is none", async () => {
    const gone = `${dir}/gone.ts`;
    expect(await readSource(gone)).toBeNull();
    const emitted = new Map<string, EmittedEntry<string>>([
      [gone, { disk: "one", value: "emitted" }],
    ]);
    expect(await loadEmittedOrDisk(emitted, gone, rehoist)).toBe("emitted");
    expect(await loadEmittedOrDisk(new Map(), gone, rehoist)).toBeUndefined();
  });
});
