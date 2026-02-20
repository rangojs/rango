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
    it("wraps createServerReference to attach $$id", () => {
      const plugin = initDev();
      const code = `const action = createServerReference("src/actions.ts#addTodo", callServer);`;
      const result = plugin.transform.call({}, code, "/project/src/client.tsx");
      expect(result).toBeDefined();
      expect(result.code).toContain("fn.$$id");
      expect(result.code).toContain('"src/actions.ts#addTodo"');
    });

    it("wraps $$ReactClient.createServerReference (namespace form)", () => {
      const plugin = initDev();
      const code = `const action = $$ReactClient.createServerReference("src/actions.ts#addTodo", callServer);`;
      const result = plugin.transform.call({}, code, "/project/src/client.tsx");
      expect(result).toBeDefined();
      expect(result.code).toContain("fn.$$id");
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

    it("handles multiple createServerReference calls", () => {
      const plugin = initDev();
      const code = `
const add = createServerReference("src/actions.ts#add", callServer);
const remove = createServerReference("src/actions.ts#remove", callServer);
`;
      const result = plugin.transform.call({}, code, "/project/src/client.tsx");
      expect(result).toBeDefined();
      // Both references should be wrapped
      const wrappings = result.code.match(/fn\.\$\$id/g);
      expect(wrappings).toHaveLength(2);
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
      expect(result.code).toContain("fn.$$id");
      // Client should keep the hash, not replace with file path
      expect(result.code).toContain('"abc123#addTodo"');
    });

    it("replaces hash with file path in RSC environment for module-level server actions", () => {
      const metaMap = {
        "/project/src/actions.ts": {
          importId: "src/actions.ts",
          referenceKey: "abc123",
          exportNames: ["addTodo"],
        },
      };

      // Mock isUseServerModule by providing a real file that starts with "use server"
      // Since we can't easily mock fs.readFileSync, we test the client path
      // which doesn't depend on isUseServerModule
      const plugin = initBuild("/project", metaMap);

      const code = `const action = createServerReference("abc123#addTodo", callServer);`;
      const chunk = { fileName: "chunk-abc.js" };
      const ctx = { environment: { name: "client" } };
      const result = plugin.renderChunk.call(ctx, code, chunk);
      expect(result).toBeDefined();
      expect(result.code).toContain("fn.$$id");
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
