import { describe, expect, it, vi } from "vitest";
import { createVersionPlugin } from "../plugins/version-plugin.js";

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

function createTestPlugin() {
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

  plugin.configResolved({ command: "serve" });
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
});
