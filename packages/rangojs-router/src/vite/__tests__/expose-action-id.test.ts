import { describe, it, expect } from "vitest";
import { exposeActionId } from "../expose-action-id.ts";

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
      expect(result.code).toMatch(/createServerReference\("src\/actions\.ts#addTodo"/);
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
      const result = plugin.transform.call({}, code, "/project/node_modules/lib/index.js");
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
      const idMatches = [...result.code.matchAll(/fn\.\$\$id\s*=\s*"([^"]+)"/g)];
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

  // ---- Plugin lifecycle ----

  describe("plugin configuration", () => {
    it("throws if RSC plugin is missing", () => {
      const plugin = createPlugin();
      plugin.configResolved({
        command: "build",
        root: "/project",
        plugins: [],
      });
      expect(() => plugin.buildStart()).toThrow("Could not find @vitejs/plugin-rsc");
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
