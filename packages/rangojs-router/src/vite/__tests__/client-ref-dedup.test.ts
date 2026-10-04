import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    const resolver = vi.fn(async () => undefined);

    // Simulate configResolved with empty exclude
    (plugin as any).configResolved({
      root: "/project",
      createResolver: vi.fn(() => resolver),
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
    const resolver = vi.fn(async () => undefined);

    (plugin as any).configResolved({
      root: "/project",
      createResolver: vi.fn(() => resolver),
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
    it("skips an absolute package source without package metadata", async () => {
      const plugin = createPlugin();
      const resolveId = (plugin as any).resolveId.bind({
        environment: { name: "client" },
      });

      const result = await resolveId(
        "/project/node_modules/fake-context-lib/internal/context.js",
        PROXY_IMPORTER,
        {},
      );
      expect(result).toBeUndefined();
    });

    it("skips a scoped package source without package metadata", async () => {
      const plugin = createPlugin();
      const resolveId = (plugin as any).resolveId.bind({
        environment: { name: "client" },
      });

      const result = await resolveId(
        "/project/node_modules/@mantine/core/esm/MantineProvider.mjs",
        PROXY_IMPORTER,
        {},
      );
      expect(result).toBeUndefined();
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
      const resolver = vi.fn(async () => undefined);
      (plugin as any).configResolved({
        root: "/project",
        createResolver: vi.fn(() => resolver),
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

    describe("public package specifiers", () => {
      let root: string;

      beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "rango-client-ref-dedup-"));
      });

      afterEach(() => {
        rmSync(root, { recursive: true, force: true });
      });

      function writePackage(
        packageRoot: string,
        name: string,
        exports: unknown,
      ): void {
        mkdirSync(packageRoot, { recursive: true });
        writeFileSync(
          join(packageRoot, "package.json"),
          JSON.stringify({ name, exports }),
        );
      }

      function writeModule(source: string): void {
        mkdirSync(dirname(source), { recursive: true });
        writeFileSync(source, "export const value = true;\n");
      }

      function createResolutionPlugin(resolver: ReturnType<typeof vi.fn>): {
        plugin: ReturnType<typeof clientRefDedup>;
        createResolver: ReturnType<typeof vi.fn>;
      } {
        const plugin = clientRefDedup();
        const createResolver = vi.fn(() => resolver);
        (plugin as any).configResolved({
          root,
          createResolver,
          environments: { client: { optimizeDeps: { exclude: [] } } },
          optimizeDeps: { exclude: [] },
        });
        return { plugin, createResolver };
      }

      async function resolveSource(
        plugin: ReturnType<typeof clientRefDedup>,
        source: string,
        optimizedResolve = vi.fn(),
      ): Promise<unknown> {
        return (plugin as any).resolveId.call(
          {
            environment: { name: "client" },
            resolve: optimizedResolve,
          },
          source,
          PROXY_IMPORTER,
          {},
        );
      }

      it("uses an explicit unscoped public subpath resolving to the source", async () => {
        const packageRoot = join(root, "node_modules", "deep-lib");
        const source = join(packageRoot, "internal", "context.js");
        writePackage(packageRoot, "deep-lib", {
          ".": "./index.js",
          "./context": "./internal/context.js",
        });
        writeModule(source);

        const resolver = vi.fn(async (id: string) =>
          id === "deep-lib/context"
            ? `${source}?v=fixture`
            : join(packageRoot, "index.js"),
        );
        const optimizedResolve = vi.fn(async () => "/node_modules/.vite/deps");
        const { plugin, createResolver } = createResolutionPlugin(resolver);

        await expect(
          resolveSource(plugin, source, optimizedResolve),
        ).resolves.toBe(
          `\0rango:dedup/${encodeURIComponent("deep-lib/context")}`,
        );
        expect(createResolver).toHaveBeenCalledWith({ scan: true });
        expect(resolver).toHaveBeenCalledWith(
          "deep-lib/context",
          join(root, "index.html"),
        );
        expect(optimizedResolve).not.toHaveBeenCalled();
      });

      it("uses an explicit scoped public subpath resolving to the source", async () => {
        const packageRoot = join(root, "node_modules", "@scope", "deep-lib");
        const source = join(packageRoot, "dist", "context.js");
        writePackage(packageRoot, "@scope/deep-lib", {
          ".": "./index.js",
          "./context": "./dist/context.js",
        });
        writeModule(source);

        const resolver = vi.fn(async (id: string) =>
          id === "@scope/deep-lib/context"
            ? source
            : join(packageRoot, "index.js"),
        );
        const { plugin } = createResolutionPlugin(resolver);

        await expect(resolveSource(plugin, source)).resolves.toBe(
          `\0rango:dedup/${encodeURIComponent("@scope/deep-lib/context")}`,
        );
      });

      it("uses the installed alias for an explicit public subpath", async () => {
        const packageRoot = join(root, "node_modules", "ui-alias");
        const source = join(packageRoot, "internal", "context.js");
        writePackage(packageRoot, "ui-lib", {
          ".": "./index.js",
          "./context": "./internal/context.js",
        });
        writeModule(source);

        const resolver = vi.fn(async (id: string) =>
          id === "ui-alias/context" ? source : undefined,
        );
        const { plugin } = createResolutionPlugin(resolver);

        await expect(resolveSource(plugin, source)).resolves.toBe(
          `\0rango:dedup/${encodeURIComponent("ui-alias/context")}`,
        );
        expect(resolver).toHaveBeenCalledTimes(1);
        expect(resolver).toHaveBeenCalledWith(
          "ui-alias/context",
          join(root, "index.html"),
        );
      });

      it("uses the installed alias for the root-barrel fallback", async () => {
        const packageRoot = join(root, "node_modules", "ui-alias");
        const source = join(packageRoot, "internal", "context.js");
        writePackage(packageRoot, "ui-lib", { ".": "./index.js" });
        writeModule(source);

        const resolver = vi.fn(async (id: string) =>
          id === "ui-alias" ? join(packageRoot, "index.js") : undefined,
        );
        const { plugin } = createResolutionPlugin(resolver);

        await expect(resolveSource(plugin, source)).resolves.toBe(
          `\0rango:dedup/${encodeURIComponent("ui-alias")}`,
        );
        expect(resolver).toHaveBeenCalledTimes(1);
        expect(resolver).toHaveBeenCalledWith(
          "ui-alias",
          join(root, "index.html"),
        );
      });

      it("falls back to the self-name when the alias root probe throws", async () => {
        const packageRoot = join(root, "node_modules", "ui-alias");
        const source = join(packageRoot, "internal", "context.js");
        writePackage(packageRoot, "ui-lib", { ".": "./index.js" });
        writeModule(source);

        const resolver = vi.fn(async (id: string) => {
          if (id === "ui-alias") throw new Error("alias is unavailable");
          return id === "ui-lib" ? join(packageRoot, "index.js") : undefined;
        });
        const { plugin } = createResolutionPlugin(resolver);

        await expect(resolveSource(plugin, source)).resolves.toBe(
          `\0rango:dedup/${encodeURIComponent("ui-lib")}`,
        );
        expect(resolver).toHaveBeenNthCalledWith(
          1,
          "ui-alias",
          join(root, "index.html"),
        );
        expect(resolver).toHaveBeenNthCalledWith(
          2,
          "ui-lib",
          join(root, "index.html"),
        );
      });

      it("continues after an earlier explicit export probe throws", async () => {
        const packageRoot = join(root, "node_modules", "deep-lib");
        const source = join(packageRoot, "internal", "context.js");
        writePackage(packageRoot, "deep-lib", {
          ".": "./index.js",
          "./unavailable": "./internal/context.js",
          "./context": "./internal/context.js",
        });
        writeModule(source);

        const resolver = vi.fn(async (id: string) => {
          if (id === "deep-lib/unavailable") {
            throw new Error("export is unavailable");
          }
          return id === "deep-lib/context"
            ? source
            : join(packageRoot, "index.js");
        });
        const { plugin } = createResolutionPlugin(resolver);

        await expect(resolveSource(plugin, source)).resolves.toBe(
          `\0rango:dedup/${encodeURIComponent("deep-lib/context")}`,
        );
        expect(resolver).toHaveBeenNthCalledWith(
          1,
          "deep-lib/unavailable",
          join(root, "index.html"),
        );
        expect(resolver).toHaveBeenNthCalledWith(
          2,
          "deep-lib/context",
          join(root, "index.html"),
        );
      });

      it("delegates conditional export selection to the unoptimized resolver", async () => {
        const packageRoot = join(root, "node_modules", "conditional-lib");
        const source = join(packageRoot, "client", "context.js");
        writePackage(packageRoot, "conditional-lib", {
          "./context": {
            "react-server": "./server/context.js",
            default: "./client/context.js",
          },
        });
        writeModule(source);

        const resolver = vi.fn(async () => source);
        const { plugin } = createResolutionPlugin(resolver);

        await expect(resolveSource(plugin, source)).resolves.toBe(
          `\0rango:dedup/${encodeURIComponent("conditional-lib/context")}`,
        );
        expect(resolver).toHaveBeenCalledWith(
          "conditional-lib/context",
          join(root, "index.html"),
        );
      });

      it("does not probe unrelated exact exports", async () => {
        const packageRoot = join(root, "node_modules", "deep-lib");
        const source = join(packageRoot, "internal", "context.js");
        writePackage(packageRoot, "deep-lib", {
          ".": "./index.js",
          "./button": "./components/button.js",
          "./context": "./internal/context.js",
          "./input": "./components/input.js",
        });
        writeModule(source);

        const resolver = vi.fn(async (id: string) => {
          if (id === "deep-lib/context") return source;
          throw new Error(`unexpected export probe: ${id}`);
        });
        const { plugin } = createResolutionPlugin(resolver);

        await expect(resolveSource(plugin, source)).resolves.toBe(
          `\0rango:dedup/${encodeURIComponent("deep-lib/context")}`,
        );
        expect(resolver).toHaveBeenCalledTimes(1);
        expect(resolver).toHaveBeenCalledWith(
          "deep-lib/context",
          join(root, "index.html"),
        );
      });

      it("maps a simple wildcard export to the exact source", async () => {
        const packageRoot = join(root, "node_modules", "wildcard-lib");
        const source = join(packageRoot, "internal", "context.js");
        writePackage(packageRoot, "wildcard-lib", {
          ".": "./index.js",
          "./features/*": "./internal/*.js",
        });
        writeModule(source);

        const resolver = vi.fn(async (id: string) =>
          id === "wildcard-lib/features/context"
            ? source
            : join(packageRoot, "index.js"),
        );
        const { plugin } = createResolutionPlugin(resolver);

        await expect(resolveSource(plugin, source)).resolves.toBe(
          `\0rango:dedup/${encodeURIComponent("wildcard-lib/features/context")}`,
        );
      });

      it("memoizes concurrent and repeated successful resolution", async () => {
        const packageRoot = join(root, "node_modules", "deep-lib");
        const source = join(packageRoot, "internal", "context.js");
        writePackage(packageRoot, "deep-lib", {
          "./context": "./internal/context.js",
        });
        writeModule(source);

        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const resolver = vi.fn(async () => {
          await gate;
          return source;
        });
        const { plugin } = createResolutionPlugin(resolver);
        const expected = `\0rango:dedup/${encodeURIComponent("deep-lib/context")}`;

        const first = resolveSource(plugin, source);
        const second = resolveSource(plugin, source);
        release!();

        await expect(Promise.all([first, second])).resolves.toEqual([
          expected,
          expected,
        ]);
        await expect(resolveSource(plugin, source)).resolves.toBe(expected);
        expect(resolver).toHaveBeenCalledTimes(1);
      });

      it("keeps the same-package root-barrel fallback", async () => {
        const packageRoot = join(root, "node_modules", "barrel-lib");
        const source = join(packageRoot, "internal", "context.js");
        writePackage(packageRoot, "barrel-lib", { ".": "./index.js" });
        writeModule(source);

        const resolver = vi.fn(async () => join(packageRoot, "index.js"));
        const { plugin } = createResolutionPlugin(resolver);

        await expect(resolveSource(plugin, source)).resolves.toBe(
          `\0rango:dedup/${encodeURIComponent("barrel-lib")}`,
        );
        expect(resolver).toHaveBeenCalledWith(
          "barrel-lib",
          join(root, "index.html"),
        );
      });

      it("uses the root-barrel fallback after unrelated export probes throw", async () => {
        const packageRoot = join(root, "node_modules", "barrel-lib");
        const source = join(packageRoot, "internal", "context.js");
        writePackage(packageRoot, "barrel-lib", {
          ".": "./index.js",
          "./button": "./internal/context.js",
          "./input": "./internal/context.js",
        });
        writeModule(source);

        const resolver = vi.fn(async (id: string) => {
          if (id !== "barrel-lib") throw new Error("export is unavailable");
          return join(packageRoot, "index.js");
        });
        const { plugin } = createResolutionPlugin(resolver);

        await expect(resolveSource(plugin, source)).resolves.toBe(
          `\0rango:dedup/${encodeURIComponent("barrel-lib")}`,
        );
        expect(resolver).toHaveBeenNthCalledWith(
          3,
          "barrel-lib",
          join(root, "index.html"),
        );
      });

      it("preserves the absolute source when package metadata is missing", async () => {
        const source = join(
          root,
          "node_modules",
          "missing-lib",
          "internal",
          "context.js",
        );
        writeModule(source);
        const resolver = vi.fn(async () => undefined);
        const { plugin } = createResolutionPlugin(resolver);

        await expect(resolveSource(plugin, source)).resolves.toBeUndefined();
        expect(resolver).not.toHaveBeenCalled();
      });

      it("retries after root resolution is absent", async () => {
        const packageRoot = join(root, "node_modules", "absent-lib");
        const source = join(packageRoot, "internal", "context.js");
        writePackage(packageRoot, "absent-lib", { ".": "./index.js" });
        writeModule(source);

        let available = false;
        const resolver = vi.fn(async () =>
          available ? join(packageRoot, "index.js") : undefined,
        );
        const { plugin } = createResolutionPlugin(resolver);

        await expect(resolveSource(plugin, source)).resolves.toBeUndefined();
        available = true;
        await expect(resolveSource(plugin, source)).resolves.toBe(
          `\0rango:dedup/${encodeURIComponent("absent-lib")}`,
        );
        expect(resolver).toHaveBeenCalledTimes(2);
      });

      it("retries after the app root resolves another package instance", async () => {
        const packageRoot = join(
          root,
          "node_modules",
          "host-lib",
          "node_modules",
          "nested-lib",
        );
        const source = join(packageRoot, "internal", "context.js");
        writePackage(packageRoot, "nested-lib", { ".": "./index.js" });
        writeModule(source);

        const appPackageRoot = join(root, "node_modules", "nested-lib");
        writePackage(appPackageRoot, "nested-lib", { ".": "./index.js" });
        let resolveNested = false;
        const resolver = vi.fn(async () =>
          join(resolveNested ? packageRoot : appPackageRoot, "index.js"),
        );
        const { plugin } = createResolutionPlugin(resolver);

        await expect(resolveSource(plugin, source)).resolves.toBeUndefined();
        resolveNested = true;
        await expect(resolveSource(plugin, source)).resolves.toBe(
          `\0rango:dedup/${encodeURIComponent("nested-lib")}`,
        );
        expect(resolver).toHaveBeenCalledTimes(2);
      });

      it("retries after the root package probe throws", async () => {
        const packageRoot = join(root, "node_modules", "throwing-lib");
        const source = join(packageRoot, "internal", "context.js");
        writePackage(packageRoot, "throwing-lib", { ".": "./index.js" });
        writeModule(source);

        let shouldThrow = true;
        const resolver = vi.fn(async () => {
          if (shouldThrow) throw new Error("resolution failed");
          return join(packageRoot, "index.js");
        });
        const { plugin } = createResolutionPlugin(resolver);

        await expect(resolveSource(plugin, source)).resolves.toBeUndefined();
        shouldThrow = false;
        await expect(resolveSource(plugin, source)).resolves.toBe(
          `\0rango:dedup/${encodeURIComponent("throwing-lib")}`,
        );
        expect(resolver).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe("load", () => {
    it("generates bare specifier re-exports for dedup modules", () => {
      const plugin = createPlugin();
      const result = (plugin as any).load(
        `\0rango:dedup/${encodeURIComponent("@mantine/core")}`,
      );

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

    it("decodes deep public specifiers from virtual IDs", () => {
      const plugin = createPlugin();
      const result = (plugin as any).load(
        `\0rango:dedup/${encodeURIComponent("deep-lib/context")}`,
      );

      expect(result).toContain('export * from "deep-lib/context"');
      expect(result).toContain('import * as __all__ from "deep-lib/context"');
    });

    it("skips non-dedup module IDs", () => {
      const plugin = createPlugin();
      const result = (plugin as any).load("/project/src/App.tsx");
      expect(result).toBeUndefined();
    });
  });
});
