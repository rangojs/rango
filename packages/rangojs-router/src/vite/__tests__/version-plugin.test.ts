import { describe, expect, it, vi } from "vitest";
import {
  createVersionPlugin,
  isViteDepCachePath,
} from "../plugins/version-plugin.js";

async function withMockedNow<T>(
  values: number[],
  run: () => Promise<T> | T,
): Promise<T> {
  const spy = vi.spyOn(Date, "now");
  let index = 0;
  spy.mockImplementation(() => values[Math.min(index++, values.length - 1)]!);
  try {
    return await run();
  } finally {
    spy.mockRestore();
  }
}

function createTestPlugin(opts: { cacheDir?: string } = {}) {
  const plugin = createVersionPlugin() as ReturnType<
    typeof createVersionPlugin
  > & {
    configResolved: (config: any) => void;
    configureServer: (server: any) => void;
    load: (id: string) => string | null;
    transform: (code: string, id: string) => any;
    hotUpdate: (this: any, ctx: any) => Promise<void>;
  };

  const invalidateModule = vi.fn();
  const versionModule = { id: "\0@rangojs/router:version" };
  const watcherHandlers = new Map<string, (file: string) => void>();
  const server = {
    environments: {
      rsc: {
        moduleGraph: {
          getModuleById: vi.fn(() => versionModule),
          invalidateModule,
        },
      },
    },
    watcher: {
      on: vi.fn((event: string, handler: (file: string) => void) => {
        watcherHandlers.set(event, handler);
      }),
    },
  };

  plugin.configResolved({ command: "serve", cacheDir: opts.cacheDir });
  plugin.configureServer(server);

  const getVersionSource = () => plugin.load("\0@rangojs/router:version");

  return {
    plugin,
    invalidateModule,
    watcherHandlers,
    getVersionSource,
  };
}

describe("createVersionPlugin", () => {
  it("does not bump version for plain use client implementation edits", async () => {
    await withMockedNow([0x1000], async () => {
      const { plugin, getVersionSource, invalidateModule } = createTestPlugin();
      const file = "/project/src/client.tsx";

      plugin.transform(
        `"use client";
export function ClientThing() {
  return <div>one</div>;
}
`,
        file,
      );

      const before = getVersionSource();

      await plugin.hotUpdate.call(
        { environment: { name: "rsc" } },
        {
          file,
          modules: [{}],
          read: async () => `"use client";
export function ClientThing() {
  return <div>two</div>;
}
`,
        },
      );

      expect(getVersionSource()).toBe(before);
      expect(invalidateModule).not.toHaveBeenCalled();
    });
  });

  it("bumps version when a use client module export surface changes", async () => {
    await withMockedNow([0x2000, 0x2001], async () => {
      const { plugin, getVersionSource, invalidateModule } = createTestPlugin();
      const file = "/project/src/client.tsx";

      plugin.transform(
        `"use client";
export function ClientThing() {
  return <div>one</div>;
}
`,
        file,
      );

      const before = getVersionSource();

      await plugin.hotUpdate.call(
        { environment: { name: "rsc" } },
        {
          file,
          modules: [{}],
          read: async () => `"use client";
export function ClientThing() {
  return <div>one</div>;
}
export const Added = 1;
`,
        },
      );

      expect(getVersionSource()).not.toBe(before);
      expect(invalidateModule).toHaveBeenCalledOnce();
    });
  });

  it("bumps version when a tracked use client module is removed", async () => {
    await withMockedNow([0x3000, 0x3001], async () => {
      const { plugin, getVersionSource, invalidateModule, watcherHandlers } =
        createTestPlugin();
      const file = "/project/src/client.tsx";

      plugin.transform(
        `"use client";
export function ClientThing() {
  return <div>one</div>;
}
`,
        file,
      );

      const before = getVersionSource();
      watcherHandlers.get("unlink")?.(file);

      expect(getVersionSource()).not.toBe(before);
      expect(invalidateModule).toHaveBeenCalledOnce();
    });
  });

  it("still bumps version for non-client RSC updates", async () => {
    await withMockedNow([0x4000, 0x4001], async () => {
      const { plugin, getVersionSource, invalidateModule } = createTestPlugin();
      const file = "/project/src/server.tsx";

      const before = getVersionSource();

      await plugin.hotUpdate.call(
        { environment: { name: "rsc" } },
        {
          file,
          modules: [{}],
          read: async () => `export function ServerThing() { return <div />; }`,
        },
      );

      expect(getVersionSource()).not.toBe(before);
      expect(invalidateModule).toHaveBeenCalledOnce();
    });
  });

  it("detects export surface change even when ctx.modules is empty", async () => {
    // When client-component-hmr plugin returns [] for "use client" files,
    // Vite sets ctx.modules to [] for subsequent plugins. The version plugin
    // must still detect export-surface changes in this case.
    await withMockedNow([0x5000, 0x5001], async () => {
      const { plugin, getVersionSource, invalidateModule } = createTestPlugin();
      const file = "/project/src/client.tsx";

      plugin.transform(
        `"use client";
export function ClientThing() {
  return <div>one</div>;
}
`,
        file,
      );

      const before = getVersionSource();

      await plugin.hotUpdate.call(
        { environment: { name: "rsc" } },
        {
          file,
          modules: [],
          read: async () => `"use client";
export function ClientThing() {
  return <div>one</div>;
}
export const NewExport = 1;
`,
        },
      );

      expect(getVersionSource()).not.toBe(before);
      expect(invalidateModule).toHaveBeenCalledOnce();
    });
  });

  it("tracks destructured exports in use client modules", async () => {
    await withMockedNow([0x6000], async () => {
      const { plugin, getVersionSource, invalidateModule } = createTestPlugin();
      const file = "/project/src/client.tsx";

      plugin.transform(
        `"use client";
export const { a, b } = obj;
export const [x, y] = arr;
`,
        file,
      );

      const before = getVersionSource();

      await plugin.hotUpdate.call(
        { environment: { name: "rsc" } },
        {
          file,
          modules: [{}],
          read: async () => `"use client";
export const { a, b } = obj;
export const [x, y] = arr;
`,
        },
      );

      // Same destructured exports, no bump
      expect(getVersionSource()).toBe(before);
      expect(invalidateModule).not.toHaveBeenCalled();
    });
  });

  it("bumps version when destructured exports change", async () => {
    await withMockedNow([0x7000, 0x7001], async () => {
      const { plugin, getVersionSource, invalidateModule } = createTestPlugin();
      const file = "/project/src/client.tsx";

      plugin.transform(
        `"use client";
export const { a, b } = obj;
`,
        file,
      );

      const before = getVersionSource();

      await plugin.hotUpdate.call(
        { environment: { name: "rsc" } },
        {
          file,
          modules: [{}],
          read: async () => `"use client";
export const { a, b, c } = obj;
`,
        },
      );

      expect(getVersionSource()).not.toBe(before);
      expect(invalidateModule).toHaveBeenCalledOnce();
    });
  });

  it("does not bump version for writes inside the resolved cacheDir", async () => {
    await withMockedNow([0x8000], async () => {
      const cacheDir = "/project/node_modules/.vite-e2e-test-app";
      const { plugin, getVersionSource, invalidateModule } = createTestPlugin({
        cacheDir,
      });

      const before = getVersionSource();

      await plugin.hotUpdate.call(
        { environment: { name: "rsc" } },
        {
          file: `${cacheDir}/deps/react-dom.js`,
          modules: [{}],
          read: async () => "// optimized dep stub",
        },
      );

      expect(getVersionSource()).toBe(before);
      expect(invalidateModule).not.toHaveBeenCalled();
    });
  });

  it("does not bump version for node_modules/.vite* dep cache writes from sibling dev servers", async () => {
    await withMockedNow([0x9000], async () => {
      const { plugin, getVersionSource, invalidateModule } = createTestPlugin();

      const before = getVersionSource();

      // Sibling dev server's optimizer writes — main server's cacheDir
      // is unrelated, so we cannot rely on the cacheDir check; the
      // segment heuristic must catch it.
      for (const file of [
        "/project/node_modules/.vite/deps/react.js",
        "/project/node_modules/.vite-temp/foo.js",
        "/project/node_modules/.vite-e2e-test-app/deps/react-dom.js",
        "/project/node_modules/.vite_rango_generate/foo.js",
        "/project/e2e/test-app/.vite-isolated/run-1/deps/react.js",
      ]) {
        await plugin.hotUpdate.call(
          { environment: { name: "rsc" } },
          { file, modules: [{}], read: async () => "// optimized dep" },
        );
      }

      expect(getVersionSource()).toBe(before);
      expect(invalidateModule).not.toHaveBeenCalled();
    });
  });

  it("still bumps version for source-file writes outside cache dirs", async () => {
    await withMockedNow([0xa000, 0xa001], async () => {
      const { plugin, getVersionSource, invalidateModule } = createTestPlugin({
        cacheDir: "/project/node_modules/.vite",
      });

      const before = getVersionSource();

      await plugin.hotUpdate.call(
        { environment: { name: "rsc" } },
        {
          file: "/project/src/server.ts",
          modules: [{}],
          read: async () => "export const x = 1;",
        },
      );

      expect(getVersionSource()).not.toBe(before);
      expect(invalidateModule).toHaveBeenCalledOnce();
    });
  });
});

describe("isViteDepCachePath", () => {
  it("matches paths inside the resolved cacheDir", () => {
    const cacheDir = "/project/node_modules/.vite-custom";
    expect(isViteDepCachePath(`${cacheDir}/deps/react.js`, cacheDir)).toBe(
      true,
    );
    expect(isViteDepCachePath(`${cacheDir}/foo.js`, cacheDir)).toBe(true);
    // Trailing slash on cacheDir should also work
    expect(
      isViteDepCachePath(`${cacheDir}/deps/react.js`, `${cacheDir}/`),
    ).toBe(true);
  });

  it("matches node_modules/.vite* heuristics regardless of cacheDir", () => {
    expect(isViteDepCachePath("/p/node_modules/.vite/deps/react.js")).toBe(
      true,
    );
    expect(isViteDepCachePath("/p/node_modules/.vite-temp/foo.js")).toBe(true);
    expect(
      isViteDepCachePath("/p/node_modules/.vite-e2e-test-app/deps/react.js"),
    ).toBe(true);
    expect(
      isViteDepCachePath("/p/node_modules/.vite_rango_generate/foo.js"),
    ).toBe(true);
  });

  it("matches .vite-isolated test-fixture cache dirs anywhere", () => {
    expect(
      isViteDepCachePath("/p/e2e/test-app/.vite-isolated/run-1/deps/x.js"),
    ).toBe(true);
  });

  it("does not match user source files", () => {
    expect(isViteDepCachePath("/p/src/index.ts")).toBe(false);
    expect(isViteDepCachePath("/p/e2e/test.ts")).toBe(false);
    expect(isViteDepCachePath("/p/node_modules/some-pkg/dist/index.js")).toBe(
      false,
    );
  });

  it("guards against empty/undefined input", () => {
    expect(isViteDepCachePath(undefined)).toBe(false);
    expect(isViteDepCachePath("")).toBe(false);
  });

  it("normalizes Windows-style paths", () => {
    expect(
      isViteDepCachePath("C:\\proj\\node_modules\\.vite\\deps\\react.js"),
    ).toBe(true);
    expect(
      isViteDepCachePath(
        "C:\\proj\\node_modules\\.vite-e2e-test-app\\deps\\react.js",
      ),
    ).toBe(true);
  });
});

describe("createVersionPlugin: the module per mode", () => {
  type Loadable = ReturnType<typeof createVersionPlugin> & {
    configResolved: (config: any) => void;
    load: (id: string) => string | null;
  };
  const load = (command: "serve" | "build") => {
    const plugin = createVersionPlugin() as Loadable;
    plugin.configResolved({ command });
    return plugin.load("\0@rangojs/router:version")!;
  };

  it("dev: one stamp for both versions, and no table", async () => {
    await withMockedNow([0x1a2b], () => {
      expect(load("serve")).toBe(
        `export const VERSION = "1a2b";\nexport const ROUTER_VERSIONS = undefined;`,
      );
    });
  });

  it("build: a placeholder for the table, and VERSION read from it", () => {
    expect(load("build")).toBe(
      `export const ROUTER_VERSIONS = __RANGO_ROUTER_VERSIONS__;\n` +
        `export const VERSION = ROUTER_VERSIONS["*"][1];`,
    );
  });

  // The build stamp used to be Date.now() and sat in a chunk every router
  // imports, so no two builds of the same source had the same server output.
  it("build: holds nothing that differs between two builds", async () => {
    const first = await withMockedNow([1000], () => load("build"));
    const second = await withMockedNow([999999], () => load("build"));
    expect(second).toBe(first);
    expect(first).not.toMatch(/"[0-9a-f]{3,}"/);
  });

  it("build: throws when evaluated before the build filled the table", () => {
    const body = load("build").replaceAll("export const", "const");
    expect(() => new Function(body)()).toThrow(ReferenceError);
  });
});
