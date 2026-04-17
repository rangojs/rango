import { describe, expect, it, afterEach } from "vitest";
import { parseAst } from "vite";
import {
  BUILD_ENV_GLOBAL_KEY,
  createCloudflareProtocolStubPlugin,
} from "../plugins/cloudflare-protocol-stub.js";

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

    // Real-world case: the Cloudflare Agents SDK ships compiled JS under
    // node_modules/agents/dist that contains `cloudflare:email` imports.
    // The transform must cover those paths — excluding node_modules would
    // leave the imports unrewritten and push the failure downstream.
    it("rewrites imports in node_modules too", () => {
      const src = `import { EmailMessage } from "cloudflare:email";\n`;
      const result = runTransform(
        src,
        "/proj/node_modules/agents/dist/index.js",
      );
      expect(result?.code).toBe(
        `import { EmailMessage } from "${VIRT}email";\n`,
      );
    });

    // AST-based rewriting — the following can never match by construction,
    // kept as documented expected behavior.
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

    it("skips files without any cloudflare: mention (cheap early exit)", () => {
      const result = runTransform(`export const x = 1;\n`, "/app/src/foo.js");
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

    it("cloudflare:workers stub has extendable DO / Worker / Workflow classes", () => {
      const p = make();
      const code = p.load(`\0${VIRT}workers`)!;
      expect(code).toContain("export class DurableObject");
      expect(code).toContain("export class WorkerEntrypoint");
      expect(code).toContain("export class WorkflowEntrypoint");
      expect(code).toContain("export class RpcTarget");
      expect(code).toContain("export const env");
    });

    it("cloudflare:email stub exports EmailMessage", () => {
      const p = make();
      const code = p.load(`\0${VIRT}email`)!;
      expect(code).toContain("export class EmailMessage");
    });

    it("cloudflare:sockets stub exports connect", () => {
      const p = make();
      const code = p.load(`\0${VIRT}sockets`)!;
      expect(code).toContain("export function connect");
    });

    it("cloudflare:workflows stub exports NonRetryableError", () => {
      const p = make();
      const code = p.load(`\0${VIRT}workflows`)!;
      expect(code).toContain("export class NonRetryableError");
    });

    it("stubs are valid ESM whose classes can be extended", async () => {
      const p = make();
      const load = async (spec: string) => {
        const code = p.load(`\0${VIRT}${spec}`)!;
        const url = `data:text/javascript;base64,${Buffer.from(code).toString(
          "base64",
        )}`;
        return import(url);
      };
      const workers = (await load("workers")) as {
        DurableObject: new (...args: unknown[]) => object;
        WorkerEntrypoint: new (...args: unknown[]) => object;
      };
      class MyDO extends workers.DurableObject {}
      class MyWE extends workers.WorkerEntrypoint {}
      expect(new MyDO()).toBeInstanceOf(workers.DurableObject);
      expect(new MyWE()).toBeInstanceOf(workers.WorkerEntrypoint);

      const email = (await load("email")) as {
        EmailMessage: new (...args: unknown[]) => object;
      };
      class MyEmail extends email.EmailMessage {}
      expect(new MyEmail()).toBeInstanceOf(email.EmailMessage);
    });

    it("falls back to an empty default export for unknown cloudflare:* modules", () => {
      const p = make();
      const code = p.load(`\0${VIRT}something-new`)!;
      expect(code).toContain("export default {}");
      expect(code).not.toContain("throw");
    });

    it("returns null from load for non-stub ids", () => {
      const p = make();
      expect(p.load("react")).toBeNull();
      expect(p.load("\0stub:virtual:rsc-router/foo")).toBeNull();
    });
  });

  describe("cloudflare:workers env injection from globalThis", () => {
    afterEach(() => {
      delete (globalThis as Record<string, unknown>)[BUILD_ENV_GLOBAL_KEY];
    });

    it("stub source references globalThis[BUILD_ENV_GLOBAL_KEY] for env", () => {
      const p = make();
      const code = p.load(`\0${VIRT}workers`)!;
      expect(code).toContain("globalThis");
      expect(code).toContain(JSON.stringify(BUILD_ENV_GLOBAL_KEY));
      expect(code).toContain("?? {}");
    });

    it("env falls back to {} when globalThis key is unset", async () => {
      delete (globalThis as Record<string, unknown>)[BUILD_ENV_GLOBAL_KEY];
      const p = make();
      // Append a nonce comment so every test gets a unique data: URL — Node
      // caches modules by URL, so without this, subsequent imports in this
      // suite would return whatever the first import captured.
      const code = p.load(`\0${VIRT}workers`)! + `\n/* ${Math.random()} */\n`;
      const url = `data:text/javascript;base64,${Buffer.from(code).toString(
        "base64",
      )}`;
      const mod = (await import(url)) as { env: object };
      expect(mod.env).toEqual({});
    });

    it("env reads the real bindings proxy when globalThis is populated", async () => {
      const sentinel = { MY_KV: { get: () => "real-value" } };
      (globalThis as Record<string, unknown>)[BUILD_ENV_GLOBAL_KEY] = sentinel;
      const p = make();
      const code = p.load(`\0${VIRT}workers`)! + `\n/* ${Math.random()} */\n`;
      const url = `data:text/javascript;base64,${Buffer.from(code).toString(
        "base64",
      )}`;
      const mod = (await import(url)) as { env: typeof sentinel };
      expect(mod.env).toBe(sentinel);
      expect(mod.env.MY_KV.get()).toBe("real-value");
    });
  });
});
