import { describe, it, expect, afterAll } from "vitest";
import { exposeActionId } from "../expose-action-id.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function createPlugin() {
  const plugin = exposeActionId();
  return plugin as typeof plugin & {
    configResolved: (config: any) => void;
    buildStart: () => void;
    transform: (this: any, code: string, id: string) => any;
    renderChunk: (this: any, code: string, chunk: any) => any;
  };
}

// Minimal mock of RSC plugin API with serverReferenceMetaMap
function mockRscPluginApi(metaMap: Record<string, any> = {}) {
  return {
    name: "rsc:minimal",
    api: {
      manager: {
        serverReferenceMetaMap: metaMap,
        config: {},
      },
    },
  };
}

function initDev(root = "/project") {
  const plugin = createPlugin();
  const rscPlugin = mockRscPluginApi();
  plugin.configResolved({
    command: "serve",
    root,
    plugins: [rscPlugin],
  });
  plugin.buildStart();
  return plugin;
}

function initBuild(root = "/project", metaMap: Record<string, any> = {}) {
  const plugin = createPlugin();
  const rscPlugin = mockRscPluginApi(metaMap);
  plugin.configResolved({
    command: "build",
    root,
    plugins: [rscPlugin],
  });
  plugin.buildStart();
  return plugin;
}

describe("exposeActionId", () => {
  // ---- Dev mode: transform ----

  describe("dev mode transform", () => {
    it("wraps createServerReference to attach $$id via IIFE", () => {
      const plugin = initDev();
      const code = `const action = createServerReference("src/actions.ts#addTodo", callServer);`;
      const result = plugin.transform.call({}, code, "/project/src/client.tsx");
      expect(result).toBeDefined();
      // Should wrap in IIFE that attaches $$id and returns fn
      expect(result.code).toMatch(
        /\(function\(fn\)\s*\{\s*fn\.\$\$id\s*=\s*"src\/actions\.ts#addTodo";\s*return fn;\s*\}\)/,
      );
      // The original createServerReference call should still be invoked
      expect(result.code).toMatch(
        /createServerReference\("src\/actions\.ts#addTodo"/,
      );
    });

    it("wraps $$ReactClient.createServerReference (namespace form)", () => {
      const plugin = initDev();
      const code = `const action = $$ReactClient.createServerReference("src/actions.ts#addTodo", callServer);`;
      const result = plugin.transform.call({}, code, "/project/src/client.tsx");
      expect(result).toBeDefined();
      // Should wrap the namespace form in IIFE with $$id
      expect(result.code).toMatch(
        /\(function\(fn\)\s*\{\s*fn\.\$\$id\s*=\s*"src\/actions\.ts#addTodo"/,
      );
      // The namespace call should be preserved
      expect(result.code).toContain("$$ReactClient.createServerReference(");
    });

    it("returns undefined for code without createServerReference", () => {
      const plugin = initDev();
      const code = `export const foo = "bar";`;
      const result = plugin.transform.call({}, code, "/project/src/other.ts");
      expect(result).toBeUndefined();
    });

    it("skips files in node_modules", () => {
      const plugin = initDev();
      const code = `const action = createServerReference("hash#fn", callServer);`;
      const result = plugin.transform.call(
        {},
        code,
        "/project/node_modules/lib/index.js",
      );
      expect(result).toBeUndefined();
    });

    it("skips transform in build mode (renderChunk handles it)", () => {
      const plugin = initBuild();
      const code = `const action = createServerReference("hash#fn", callServer);`;
      const result = plugin.transform.call({}, code, "/project/src/client.tsx");
      expect(result).toBeUndefined();
    });

    it("handles multiple createServerReference calls with distinct IDs", () => {
      const plugin = initDev();
      const code = `
const add = createServerReference("src/actions.ts#add", callServer);
const remove = createServerReference("src/actions.ts#remove", callServer);
`;
      const result = plugin.transform.call({}, code, "/project/src/client.tsx");
      expect(result).toBeDefined();
      // Both references should be wrapped with IIFE
      const idMatches = [
        ...result.code.matchAll(/fn\.\$\$id\s*=\s*"([^"]+)"/g),
      ];
      expect(idMatches).toHaveLength(2);
      // Each should have a distinct action ID
      expect(idMatches[0][1]).toBe("src/actions.ts#add");
      expect(idMatches[1][1]).toBe("src/actions.ts#remove");
    });
  });

  // ---- Build mode: renderChunk ----

  describe("build mode renderChunk", () => {
    it("wraps createServerReference in client environment (keeps hash)", () => {
      const plugin = initBuild();
      const code = `const action = createServerReference("abc123#addTodo", callServer);`;
      const chunk = { fileName: "chunk-abc.js" };
      const ctx = { environment: { name: "client" } };
      const result = plugin.renderChunk.call(ctx, code, chunk);
      expect(result).toBeDefined();
      // Should wrap in IIFE with $$id preserving the original hash
      expect(result.code).toMatch(
        /\(function\(fn\)\s*\{\s*fn\.\$\$id\s*=\s*"abc123#addTodo"/,
      );
      // Client should keep the hash, not replace with file path
      expect(result.code).not.toMatch(/src\/actions/);
    });

    it("keeps hash in client environment even when metaMap has file mappings", () => {
      const metaMap = {
        "/project/src/actions.ts": {
          importId: "src/actions.ts",
          referenceKey: "abc123",
          exportNames: ["addTodo"],
        },
      };

      // Client environment should always keep hash IDs for security,
      // regardless of metaMap contents (only RSC env gets file paths)
      const plugin = initBuild("/project", metaMap);

      const code = `const action = createServerReference("abc123#addTodo", callServer);`;
      const chunk = { fileName: "chunk-abc.js" };
      const ctx = { environment: { name: "client" } };
      const result = plugin.renderChunk.call(ctx, code, chunk);
      expect(result).toBeDefined();
      // Client should still use hash, not file path
      expect(result.code).toMatch(/fn\.\$\$id\s*=\s*"abc123#addTodo"/);
    });

    it("keeps hash in SSR environment (must match client bundle for hydration)", () => {
      const metaMap = {
        "/project/src/actions.ts": {
          importId: "src/actions.ts",
          referenceKey: "abc123",
          exportNames: ["addTodo"],
        },
      };
      const plugin = initBuild("/project", metaMap);
      const code = `const action = createServerReference("abc123#addTodo", callServer);`;
      const chunk = { fileName: "chunk-ssr.js" };
      // SSR environment should keep hash IDs (same as client) to avoid error #418
      const ctx = { environment: { name: "ssr" } };
      const result = plugin.renderChunk.call(ctx, code, chunk);
      expect(result).toBeDefined();
      expect(result.code).toMatch(/fn\.\$\$id\s*=\s*"abc123#addTodo"/);
    });

    it("returns null for code without createServerReference", () => {
      const plugin = initBuild();
      const code = `export const foo = "bar";`;
      const chunk = { fileName: "chunk-abc.js" };
      const ctx = { environment: { name: "client" } };
      const result = plugin.renderChunk.call(ctx, code, chunk);
      expect(result).toBeNull();
    });

    it("returns source map with chunk fileName as source", () => {
      const plugin = initBuild();
      const code = `const action = createServerReference("hash#fn", callServer);`;
      const chunk = { fileName: "assets/chunk-xyz.js" };
      const ctx = { environment: { name: "client" } };
      const result = plugin.renderChunk.call(ctx, code, chunk);
      expect(result).toBeDefined();
      expect(result.map).toBeDefined();
      // Source map should reference the chunk fileName
      expect(result.map.sources).toContain("assets/chunk-xyz.js");
    });
  });

  // ---- RSC environment: registerServerReference ----

  describe("RSC environment renderChunk", () => {
    // Create a temp directory with a "use server" file for isUseServerModule to read
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "action-test-"));
    const actionsFile = path.join(tmpDir, "src", "actions.ts");
    fs.mkdirSync(path.dirname(actionsFile), { recursive: true });
    fs.writeFileSync(
      actionsFile,
      '"use server";\nexport async function addTodo() {}\nexport async function removeTodo() {}',
    );

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function initRscBuild() {
      const metaMap: Record<string, any> = {};
      metaMap[actionsFile] = {
        importId: "src/actions.ts",
        referenceKey: "abc123",
        exportNames: ["addTodo", "removeTodo"],
      };
      return initBuild(tmpDir, metaMap);
    }

    it("replaces hash with file path for createServerReference $$id in RSC env", () => {
      const plugin = initRscBuild();
      const code = `const action = createServerReference("abc123#addTodo", callServer);`;
      const chunk = { fileName: "chunk-rsc.js" };
      const ctx = { environment: { name: "rsc" } };
      const result = plugin.renderChunk.call(ctx, code, chunk);
      expect(result).toBeDefined();
      // RSC environment should replace hash with file path
      expect(result.code).toMatch(
        /fn\.\$\$id\s*=\s*"src\/actions\.ts#addTodo"/,
      );
    });

    it("wraps registerServerReference with $id (single dollar) in RSC env", () => {
      const plugin = initRscBuild();
      const code = `registerServerReference(addTodoFn, "abc123", "addTodo");`;
      const chunk = { fileName: "chunk-rsc.js" };
      const ctx = { environment: { name: "rsc" } };
      const result = plugin.renderChunk.call(ctx, code, chunk);
      expect(result).toBeDefined();
      // Should wrap with IIFE attaching $id (single dollar, not $$id)
      expect(result.code).toMatch(
        /\(function\(fn\)\s*\{\s*fn\.\$id\s*=\s*"src\/actions\.ts#addTodo"/,
      );
      // Original registerServerReference should still be called with original hash
      expect(result.code).toMatch(
        /registerServerReference\(addTodoFn,\s*"abc123",\s*"addTodo"\)/,
      );
    });

    it("handles both createServerReference and registerServerReference in same chunk", () => {
      const plugin = initRscBuild();
      const code = [
        `const ref = createServerReference("abc123#addTodo", callServer);`,
        `registerServerReference(addTodoFn, "abc123", "addTodo");`,
      ].join("\n");
      const chunk = { fileName: "chunk-rsc.js" };
      const ctx = { environment: { name: "rsc" } };
      const result = plugin.renderChunk.call(ctx, code, chunk);
      expect(result).toBeDefined();
      // Both should be wrapped
      expect(result.code).toMatch(
        /fn\.\$\$id\s*=\s*"src\/actions\.ts#addTodo"/,
      );
      expect(result.code).toMatch(/fn\.\$id\s*=\s*"src\/actions\.ts#addTodo"/);
      // Single sourcemap covering both transforms
      expect(result.map).toBeDefined();
      expect(result.map.sources).toContain("chunk-rsc.js");
    });

    it("does not transform registerServerReference for non-use-server files", () => {
      // Initialize with metaMap pointing to a non-existent file (isUseServerModule returns false)
      const metaMap = {
        "/project/src/component.tsx": {
          importId: "src/component.tsx",
          referenceKey: "def456",
          exportNames: ["inlineAction"],
        },
      };
      const plugin = initBuild("/project", metaMap);
      const code = `registerServerReference(inlineActionFn, "def456", "inlineAction");`;
      const chunk = { fileName: "chunk-rsc.js" };
      const ctx = { environment: { name: "rsc" } };
      const result = plugin.renderChunk.call(ctx, code, chunk);
      // No hashToFileMap entry for def456 (file is not "use server"), so no $id wrapping
      expect(result).toBeNull();
    });

    it("returns null in RSC env when code has no server references", () => {
      const plugin = initRscBuild();
      const code = `export const foo = "bar";`;
      const chunk = { fileName: "chunk-rsc.js" };
      const ctx = { environment: { name: "rsc" } };
      const result = plugin.renderChunk.call(ctx, code, chunk);
      expect(result).toBeNull();
    });
  });

  // ---- isUseServerModule filtering (tested via buildStart + renderChunk) ----

  describe("use server module detection", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "use-server-test-"));

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeModule(name: string, content: string): string {
      const filePath = path.join(tmpDir, name);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
      return filePath;
    }

    function isHashMapped(filePath: string, hash: string): boolean {
      const metaMap: Record<string, any> = {};
      metaMap[filePath] = {
        importId: path.relative(tmpDir, filePath),
        referenceKey: hash,
        exportNames: ["action"],
      };
      const plugin = initBuild(tmpDir, metaMap);
      // Test via registerServerReference in RSC env
      const code = `registerServerReference(actionFn, "${hash}", "action");`;
      const ctx = { environment: { name: "rsc" } };
      const result = plugin.renderChunk.call(ctx, code, {
        fileName: "test.js",
      });
      // If isUseServerModule returned true, the hash will be in hashToFileMap
      // and registerServerReference will be wrapped with $id
      return result !== null && result.code.includes("fn.$id");
    }

    it("detects double-quoted 'use server' directive", () => {
      const fp = writeModule(
        "double.ts",
        '"use server";\nexport async function action() {}',
      );
      expect(isHashMapped(fp, "hash1")).toBe(true);
    });

    it("detects single-quoted 'use server' directive", () => {
      const fp = writeModule(
        "single.ts",
        "'use server';\nexport async function action() {}",
      );
      expect(isHashMapped(fp, "hash2")).toBe(true);
    });

    it("detects directive after comments", () => {
      const fp = writeModule(
        "commented.ts",
        '// file header\n/* license */\n"use server";\nexport async function action() {}',
      );
      expect(isHashMapped(fp, "hash3")).toBe(true);
    });

    it("rejects file without use server directive", () => {
      const fp = writeModule(
        "no-directive.ts",
        "export async function action() {}",
      );
      expect(isHashMapped(fp, "hash4")).toBe(false);
    });

    it("rejects file with use server inside function (not module-level)", () => {
      const fp = writeModule(
        "inline.tsx",
        'export function Component() {\n  async function action() {\n    "use server";\n  }\n}',
      );
      expect(isHashMapped(fp, "hash5")).toBe(false);
    });

    it("handles nonexistent file gracefully", () => {
      expect(isHashMapped("/nonexistent/path.ts", "hash6")).toBe(false);
    });
  });

  // ---- Plugin lifecycle ----

  describe("plugin configuration", () => {
    it("throws if RSC plugin is missing", () => {
      const plugin = createPlugin();
      plugin.configResolved({
        command: "build",
        root: "/project",
        plugins: [],
      });
      expect(() => plugin.buildStart()).toThrow(
        "Could not find @vitejs/plugin-rsc",
      );
    });

    it("has enforce: post", () => {
      const plugin = createPlugin();
      expect(plugin.enforce).toBe("post");
    });

    it("has the correct plugin name", () => {
      const plugin = createPlugin();
      expect(plugin.name).toBe("@rangojs/router:expose-action-id");
    });
  });
});
