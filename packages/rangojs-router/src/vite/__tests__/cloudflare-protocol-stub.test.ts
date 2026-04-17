import { describe, expect, it } from "vitest";
import { parseAst } from "vite";
import { createCloudflareProtocolStubPlugin } from "../plugins/cloudflare-protocol-stub.js";

type TransformResult = { code: string; map: null } | null;

interface PluginWithHooks {
  transform: (
    this: { parse: typeof parseAst },
    code: string,
    id: string,
  ) => TransformResult;
  resolveId: (id: string) => string | null;
  load: (id: string) => string | null;
}

function make(): PluginWithHooks {
  return createCloudflareProtocolStubPlugin() as unknown as PluginWithHooks;
}

// Every transform call needs a Rollup/Vite plugin context with a .parse()
// method. Production code gets this automatically from Vite; tests provide
// their own using Vite's re-exported parser.
const ctx = { parse: parseAst };

function runTransform(src: string, id: string): TransformResult {
  return make().transform.call(ctx, src, id);
}

const VIRT = "virtual:rango-cloudflare-stub-";

describe("createCloudflareProtocolStubPlugin", () => {
  describe("transform", () => {
    it("rewrites static `from` imports of cloudflare:* to a virtual module name", () => {
      const src = `import { DurableObject } from "cloudflare:workers";\n`;
      const result = runTransform(src, "/app/src/worker.js");
      expect(result?.code).toBe(
        `import { DurableObject } from "${VIRT}workers";\n`,
      );
    });

    it("rewrites single-quoted and side-effect imports", () => {
      const src = `import 'cloudflare:workers';\n`;
      const result = runTransform(src, "/app/src/worker.js");
      expect(result?.code).toBe(`import '${VIRT}workers';\n`);
    });

    it("rewrites dynamic imports with a string-literal specifier", () => {
      const src = `const m = await import("cloudflare:workers");\n`;
      const result = runTransform(src, "/app/src/worker.js");
      expect(result?.code).toContain(`import("${VIRT}workers")`);
    });

    it("leaves dynamic imports with non-literal specifiers alone", () => {
      const src = `const m = await import("cloudflare:" + name);\n`;
      const result = runTransform(src, "/app/src/worker.js");
      // BinaryExpression source is not a Literal, so no rewrite.
      expect(result).toBeNull();
    });

    it("rewrites re-exports", () => {
      const src = `export { DurableObject } from "cloudflare:workers";\n`;
      const result = runTransform(src, "/app/src/worker.js");
      expect(result?.code).toBe(
        `export { DurableObject } from "${VIRT}workers";\n`,
      );
    });

    it("rewrites `export * from`", () => {
      const src = `export * from "cloudflare:workers";\n`;
      const result = runTransform(src, "/app/src/worker.js");
      expect(result?.code).toBe(`export * from "${VIRT}workers";\n`);
    });

    it("rewrites multiple imports in a single module (offset stability)", () => {
      const src =
        `import { DurableObject } from "cloudflare:workers";\n` +
        `import { EmailMessage } from "cloudflare:email";\n`;
      const result = runTransform(src, "/app/src/worker.js");
      expect(result?.code).toBe(
        `import { DurableObject } from "${VIRT}workers";\n` +
          `import { EmailMessage } from "${VIRT}email";\n`,
      );
    });

    // Regression guards: AST-based rewriting means these could never match
    // by construction, but kept as documented expected behavior.
    it("does NOT rewrite cloudflare:* inside string literals", () => {
      const src = `const s = "import(\\"cloudflare:workers\\")";\n`;
      const result = runTransform(src, "/app/src/worker.js");
      expect(result).toBeNull();
    });

    it("does NOT rewrite cloudflare:* inside line comments", () => {
      const src = `// import("cloudflare:workers")\nexport const x = 1;\n`;
      const result = runTransform(src, "/app/src/worker.js");
      expect(result).toBeNull();
    });

    it("does NOT rewrite cloudflare:* inside block comments", () => {
      const src = `/* from "cloudflare:workers" */\nexport const x = 1;\n`;
      const result = runTransform(src, "/app/src/worker.js");
      expect(result).toBeNull();
    });

    it("does NOT rewrite cloudflare:* inside template literals", () => {
      const src = 'const msg = `from "cloudflare:workers"`;\nexport { msg };\n';
      const result = runTransform(src, "/app/src/worker.js");
      expect(result).toBeNull();
    });

    it("rewrites only the real import when it coexists with a string literal lookalike", () => {
      const src =
        `const note = "avoid importing from cloudflare:workers directly";\n` +
        `import { DurableObject } from "cloudflare:workers";\n`;
      const result = runTransform(src, "/app/src/worker.js");
      expect(result?.code).toBe(
        `const note = "avoid importing from cloudflare:workers directly";\n` +
          `import { DurableObject } from "${VIRT}workers";\n`,
      );
    });

    it("skips files without any cloudflare: mention (cheap early exit)", () => {
      const result = runTransform(`export const x = 1;\n`, "/app/src/foo.js");
      expect(result).toBeNull();
    });

    it("skips node_modules", () => {
      const src = `import { DurableObject } from "cloudflare:workers";\n`;
      const result = runTransform(src, "/proj/node_modules/pkg/dist/index.js");
      expect(result).toBeNull();
    });

    it("skips non-source files (e.g. .css, .json)", () => {
      const src = `@import "cloudflare:workers";\n`;
      const result = runTransform(src, "/app/src/styles.css");
      expect(result).toBeNull();
    });

    it("handles query-suffixed source ids", () => {
      const src = `import { DurableObject } from "cloudflare:workers";\n`;
      const result = runTransform(src, "/app/src/worker.js?commonjs-proxy");
      expect(result?.code).toBe(
        `import { DurableObject } from "${VIRT}workers";\n`,
      );
    });

    it("returns null for malformed source rather than throwing", () => {
      const src = `import { from "cloudflare:workers";\n`;
      const result = runTransform(src, "/app/src/worker.js");
      expect(result).toBeNull();
    });
  });

  describe("resolveId / load", () => {
    it("resolves the rewritten virtual module name to a null-byte-prefixed id", () => {
      const p = make();
      expect(p.resolveId(`${VIRT}workers`)).toBe(`\0${VIRT}workers`);
      expect(p.resolveId(`${VIRT}email`)).toBe(`\0${VIRT}email`);
    });

    it("does not touch unrelated specifiers", () => {
      const p = make();
      expect(p.resolveId("react")).toBeNull();
      expect(p.resolveId("virtual:rsc-router/foo")).toBeNull();
      expect(p.resolveId("cloudflare:workers")).toBeNull();
    });

    it("emits cloudflare:workers stub with extendable base classes", () => {
      const p = make();
      const code = p.load(`\0${VIRT}workers`)!;
      expect(code).toContain("export class DurableObject");
      expect(code).toContain("export class WorkerEntrypoint");
      expect(code).toContain("export class WorkflowEntrypoint");
      expect(code).toContain("export class RpcTarget");
      expect(code).toContain("export const env");
    });

    it("cloudflare:workers stub is valid ESM whose classes can be extended", async () => {
      const p = make();
      const code = p.load(`\0${VIRT}workers`)!;
      const url = `data:text/javascript;base64,${Buffer.from(code).toString(
        "base64",
      )}`;
      const mod = (await import(url)) as {
        DurableObject: new (...args: unknown[]) => object;
        WorkerEntrypoint: new (...args: unknown[]) => object;
        env: object;
      };
      class MyDO extends mod.DurableObject {}
      class MyWE extends mod.WorkerEntrypoint {}
      expect(new MyDO()).toBeInstanceOf(mod.DurableObject);
      expect(new MyWE()).toBeInstanceOf(mod.WorkerEntrypoint);
      expect(mod.env).toEqual({});
    });

    it("throws a descriptive error for unsupported cloudflare:* modules", () => {
      const p = make();
      expect(() => p.load(`\0${VIRT}email`)).toThrow(
        /Unsupported `cloudflare:email`/,
      );
      expect(() => p.load(`\0${VIRT}something-new`)).toThrow(
        /cloudflare-protocol-stub\.ts/,
      );
    });

    it("returns null from load for non-stub ids", () => {
      const p = make();
      expect(p.load("react")).toBeNull();
      expect(p.load("\0stub:virtual:rsc-router/foo")).toBeNull();
    });
  });
});
