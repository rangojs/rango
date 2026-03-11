import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extractPackageName,
  clientRefDedup,
} from "../plugins/client-ref-dedup.js";

describe("extractPackageName", () => {
  it("extracts unscoped package name", () => {
    expect(
      extractPackageName(
        "/project/node_modules/fake-context-lib/internal/context.js",
      ),
    ).toBe("fake-context-lib");
  });

  it("extracts scoped package name", () => {
    expect(
      extractPackageName(
        "/project/node_modules/@mantine/core/esm/MantineProvider.mjs",
      ),
    ).toBe("@mantine/core");
  });

  it("uses last node_modules segment for nested deps", () => {
    expect(
      extractPackageName(
        "/project/node_modules/@mantine/core/node_modules/react/index.js",
      ),
    ).toBe("react");
  });

  it("extracts package name without subpath", () => {
    expect(extractPackageName("/project/node_modules/react")).toBe("react");
  });

  it("returns null for paths without node_modules", () => {
    expect(extractPackageName("/project/src/components/Button.tsx")).toBeNull();
  });

  it("returns null for incomplete scoped package", () => {
    expect(extractPackageName("/project/node_modules/@org")).toBeNull();
  });

  it("returns null for empty string after node_modules", () => {
    expect(extractPackageName("/project/node_modules/")).toBeNull();
  });

  it("handles deeply nested submodule paths", () => {
    expect(
      extractPackageName(
        "/project/node_modules/@org/pkg/dist/esm/internal/deep/module.mjs",
      ),
    ).toBe("@org/pkg");
  });
});

describe("clientRefDedup plugin", () => {
  const PROXY_IMPORTER =
    "/@id/__x00__virtual:vite-rsc/client-in-server-package-proxy/%2Fproject%2Fnode_modules%2Ffake-context-lib%2Finternal%2Fcontext.js";

  function createPlugin() {
    const plugin = clientRefDedup();

    // Simulate configResolved with empty exclude
    (plugin as any).configResolved({
      environments: {
        client: {
          optimizeDeps: { exclude: [] },
        },
      },
      optimizeDeps: { exclude: [] },
    });

    return plugin;
  }

  function createPluginWithExclude(exclude: string[]) {
    const plugin = clientRefDedup();

    (plugin as any).configResolved({
      environments: {
        client: {
          optimizeDeps: { exclude },
        },
      },
      optimizeDeps: { exclude: [] },
    });

    return plugin;
  }

  it("has correct metadata", () => {
    const plugin = clientRefDedup();
    expect(plugin.name).toBe("@rangojs/router:client-ref-dedup");
    expect(plugin.enforce).toBe("pre");
    expect(plugin.apply).toBe("serve");
  });

  describe("resolveId", () => {
    it("redirects absolute node_modules import from proxy in client env", () => {
      const plugin = createPlugin();
      const resolveId = (plugin as any).resolveId.bind({
        environment: { name: "client" },
      });

      const result = resolveId(
        "/project/node_modules/fake-context-lib/internal/context.js",
        PROXY_IMPORTER,
        {},
      );
      expect(result).toBe("\0rango:dedup/fake-context-lib");
    });

    it("redirects scoped package imports", () => {
      const plugin = createPlugin();
      const resolveId = (plugin as any).resolveId.bind({
        environment: { name: "client" },
      });

      const result = resolveId(
        "/project/node_modules/@mantine/core/esm/MantineProvider.mjs",
        PROXY_IMPORTER,
        {},
      );
      expect(result).toBe("\0rango:dedup/@mantine/core");
    });

    it("skips non-client environments", () => {
      const plugin = createPlugin();
      const resolveId = (plugin as any).resolveId.bind({
        environment: { name: "rsc" },
      });

      const result = resolveId(
        "/project/node_modules/fake-context-lib/internal/context.js",
        PROXY_IMPORTER,
        {},
      );
      expect(result).toBeUndefined();
    });

    it("skips imports not from proxy modules", () => {
      const plugin = createPlugin();
      const resolveId = (plugin as any).resolveId.bind({
        environment: { name: "client" },
      });

      const result = resolveId(
        "/project/node_modules/fake-context-lib/internal/context.js",
        "/project/src/App.tsx",
        {},
      );
      expect(result).toBeUndefined();
    });

    it("skips non-absolute paths", () => {
      const plugin = createPlugin();
      const resolveId = (plugin as any).resolveId.bind({
        environment: { name: "client" },
      });

      const result = resolveId("fake-context-lib", PROXY_IMPORTER, {});
      expect(result).toBeUndefined();
    });

    it("skips paths without node_modules", () => {
      const plugin = createPlugin();
      const resolveId = (plugin as any).resolveId.bind({
        environment: { name: "client" },
      });

      const result = resolveId(
        "/project/src/components/Button.tsx",
        PROXY_IMPORTER,
        {},
      );
      expect(result).toBeUndefined();
    });

    it("skips when importer is undefined", () => {
      const plugin = createPlugin();
      const resolveId = (plugin as any).resolveId.bind({
        environment: { name: "client" },
      });

      const result = resolveId(
        "/project/node_modules/fake-context-lib/internal/context.js",
        undefined,
        {},
      );
      expect(result).toBeUndefined();
    });

    it("respects optimizeDeps.exclude from client environment", () => {
      const plugin = createPluginWithExclude(["fake-context-lib"]);
      const resolveId = (plugin as any).resolveId.bind({
        environment: { name: "client" },
      });

      const result = resolveId(
        "/project/node_modules/fake-context-lib/internal/context.js",
        PROXY_IMPORTER,
        {},
      );
      expect(result).toBeUndefined();
    });

    it("falls back to top-level optimizeDeps.exclude", () => {
      const plugin = clientRefDedup();
      (plugin as any).configResolved({
        environments: {},
        optimizeDeps: { exclude: ["fake-context-lib"] },
      });

      const resolveId = (plugin as any).resolveId.bind({
        environment: { name: "client" },
      });

      const result = resolveId(
        "/project/node_modules/fake-context-lib/internal/context.js",
        PROXY_IMPORTER,
        {},
      );
      expect(result).toBeUndefined();
    });
  });

  describe("load", () => {
    it("generates bare specifier re-exports for dedup modules", () => {
      const plugin = createPlugin();
      const result = (plugin as any).load("\0rango:dedup/@mantine/core");

      expect(result).toContain('export * from "@mantine/core"');
      expect(result).toContain('import * as __all__ from "@mantine/core"');
      expect(result).toContain("export default __all__.default");
    });

    it("generates correct output for unscoped packages", () => {
      const plugin = createPlugin();
      const result = (plugin as any).load("\0rango:dedup/fake-context-lib");

      expect(result).toContain('export * from "fake-context-lib"');
      expect(result).toContain('import * as __all__ from "fake-context-lib"');
      expect(result).toContain("export default __all__.default");
    });

    it("skips non-dedup module IDs", () => {
      const plugin = createPlugin();
      const result = (plugin as any).load("/project/src/App.tsx");
      expect(result).toBeUndefined();
    });
  });
});
