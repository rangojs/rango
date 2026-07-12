import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const pkg = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8"),
) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe("package manifest", () => {
  /**
   * typescript is a RUNTIME dependency, not a dev one (#780): the vite plugin
   * and `rango generate` parse routers with the TS compiler API
   * (src/build/route-types/*), bundled top-level into dist/vite/index.js. As a
   * devDependency, a pure-JS consumer app (no typescript of its own) crashed at
   * vite config load with ERR_MODULE_NOT_FOUND — masked in this monorepo by
   * hoisting and in TS apps by their own typescript install.
   */
  it("declares typescript as a runtime dependency (#780)", () => {
    expect(pkg.dependencies.typescript).toBeDefined();
    expect(pkg.devDependencies.typescript).toBeUndefined();
  });

  /**
   * The range must NOT allow typescript 7: the native (Go) port's main entry
   * exports only { version, versionMajorMinor } — no ts.createSourceFile — so
   * resolving 7 would crash route-type generation. 5.x and 6.x ship the full
   * compiler API (6.0.3 verified: identical gen output). Revisit when the
   * generator is ported to typescript/unstable/ast.
   */
  it("keeps the typescript range on compiler-API majors (5/6)", () => {
    expect(pkg.dependencies.typescript).toBe("^5.3.0 || ^6.0.0");
  });
});
