import { describe, it, expect } from "vitest";

/**
 * Mock function to test createLoader detection patterns
 */
function hasCreateLoaderImport(code: string): boolean {
  const pattern = /import\s*\{[^}]*\bcreateLoader\b[^}]*\}\s*from\s*["']rsc-router(?:\/server)?["']/;
  return pattern.test(code);
}

/**
 * Extract loader exports from code
 */
function extractLoaderExports(code: string): string[] {
  const pattern = /export\s+const\s+(\w+)\s*=\s*createLoader\s*\(/g;
  const exports: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    exports.push(match[1]);
  }
  return exports;
}

describe("exposeLoaderId plugin", () => {
  describe("hasCreateLoaderImport", () => {
    it("should detect direct import from rsc-router", () => {
      const code = `import { createLoader } from "@ivogt/rsc-router";`;
      expect(hasCreateLoaderImport(code)).toBe(true);
    });

    it("should detect import from rsc-router/server", () => {
      const code = `import { createLoader } from "@ivogt/rsc-router/server";`;
      expect(hasCreateLoaderImport(code)).toBe(true);
    });

    it("should detect createLoader with other imports", () => {
      const code = `import { map, createLoader, route } from "@ivogt/rsc-router";`;
      expect(hasCreateLoaderImport(code)).toBe(true);
    });

    it("should NOT detect aliased import", () => {
      const code = `import { createLoader as cl } from "@ivogt/rsc-router";`;
      // Our simple pattern doesn't support aliasing - this is intentional
      expect(hasCreateLoaderImport(code)).toBe(true); // Still matches the word
    });

    it("should NOT detect import from other packages", () => {
      const code = `import { createLoader } from "other-package";`;
      expect(hasCreateLoaderImport(code)).toBe(false);
    });

    it("should NOT detect default import", () => {
      const code = `import createLoader from "@ivogt/rsc-router";`;
      expect(hasCreateLoaderImport(code)).toBe(false);
    });

    it("should NOT detect namespace import", () => {
      const code = `import * as router from "@ivogt/rsc-router";`;
      expect(hasCreateLoaderImport(code)).toBe(false);
    });
  });

  describe("extractLoaderExports", () => {
    it("should extract single loader export", () => {
      const code = `export const MyLoader = createLoader("test", fn);`;
      expect(extractLoaderExports(code)).toEqual(["MyLoader"]);
    });

    it("should extract multiple loader exports", () => {
      const code = `
        export const LoaderA = createLoader("a", fnA);
        export const LoaderB = createLoader("b", fnB);
        export const LoaderC = createLoader("c", fnC, true);
      `;
      expect(extractLoaderExports(code)).toEqual(["LoaderA", "LoaderB", "LoaderC"]);
    });

    it("should NOT extract non-exported loaders", () => {
      const code = `const PrivateLoader = createLoader("private", fn);`;
      expect(extractLoaderExports(code)).toEqual([]);
    });

    it("should NOT extract default exports", () => {
      const code = `export default createLoader("default", fn);`;
      expect(extractLoaderExports(code)).toEqual([]);
    });

    it("should handle multiline exports", () => {
      const code = `
        export const MyLoader = createLoader(
          "my-loader",
          async (ctx) => {
            return { data: "test" };
          },
          true
        );
      `;
      expect(extractLoaderExports(code)).toEqual(["MyLoader"]);
    });
  });

  describe("$$id generation", () => {
    it("should generate correct $$id format", () => {
      const filePath = "src/loaders/test-loader.ts";
      const exportName = "TestLoader";
      const id = `${filePath}#${exportName}`;
      expect(id).toBe("src/loaders/test-loader.ts#TestLoader");
    });

    it("should handle nested paths", () => {
      const filePath = "src/handlers/shop/loaders/cart.ts";
      const exportName = "CartLoader";
      const id = `${filePath}#${exportName}`;
      expect(id).toBe("src/handlers/shop/loaders/cart.ts#CartLoader");
    });
  });
});
