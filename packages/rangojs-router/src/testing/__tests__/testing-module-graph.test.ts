import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createServer,
  type RunnableDevEnvironment,
  type ViteDevServer,
} from "vite";
import { afterEach, describe, expect, it } from "vitest";

// `@rangojs/router/testing` runs in a plain Vitest project, where
// @vitejs/plugin-rsc's entries cannot load (they import Vite virtuals). A
// fresh Vite module runner records every module it evaluates: the barrel and
// what dispatch() loads for a response route (its lazy import of the request
// stages, the response-cache leaf) must never include plugin-rsc.

const PACKAGE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const pkg = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as { exports: Record<string, { default: string }> };

let server: ViteDevServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function startRunner(): Promise<RunnableDevEnvironment> {
  server = await createServer({
    configFile: false,
    root: PACKAGE_ROOT,
    logLevel: "silent",
    appType: "custom",
    server: { middlewareMode: true, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: {
      alias: {
        "@rangojs/router:version": fileURLToPath(
          new URL("../../__mocks__/version.ts", import.meta.url),
        ),
      },
    },
  });
  return server.environments.ssr as RunnableDevEnvironment;
}

function pluginRscModules(ssr: RunnableDevEnvironment): string[] {
  return [...ssr.runner.evaluatedModules.idToModuleMap.keys()].filter((id) =>
    id.includes("@vitejs/plugin-rsc"),
  );
}

/** A plugin-rsc entry fails to load here; name it instead of the loader error. */
async function evaluate<T>(
  ssr: RunnableDevEnvironment,
  what: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(
      `${what} failed; plugin-rsc modules evaluated: ${pluginRscModules(ssr).join(", ") || "none"}`,
      { cause: error },
    );
  }
}

function load<T>(ssr: RunnableDevEnvironment, id: string): Promise<T> {
  return evaluate(ssr, `import ${id}`, () =>
    ssr.runner.import(id),
  ) as Promise<T>;
}

describe("@rangojs/router/testing module graph", () => {
  // Transforms the barrel's graph from scratch: seconds under a loaded runner.
  it(
    "loads no @vitejs/plugin-rsc module on import or on a dispatch",
    {
      timeout: 60_000,
    },
    async () => {
      const ssr = await startRunner();
      // The entry the package export resolves to.
      const entry = pkg.exports["./testing"].default;
      expect(entry).toBe("./src/testing/index.ts");

      const testing = await load<typeof import("../index.js")>(
        ssr,
        entry.slice(1),
      );
      expect(ssr.runner.evaluatedModules.idToModuleMap.size).toBeGreaterThan(1);
      expect(pluginRscModules(ssr)).toEqual([]);

      const { createRouter } = await load<typeof import("../../router.js")>(
        ssr,
        "/src/router.ts",
      );
      const { urls } = await load<typeof import("../../urls/urls-function.js")>(
        ssr,
        "/src/urls/urls-function.ts",
      );
      const { MemorySegmentCacheStore } = await load<
        typeof import("../../cache/memory-segment-store.js")
      >(ssr, "/src/cache/memory-segment-store.ts");
      const router = createRouter({
        id: "testing-module-graph",
        cache: { store: new MemorySegmentCacheStore() },
      })
        .use(async (_ctx, next) => {
          await next();
        })
        .routes(
          urls(({ path, cache }) => [
            cache({ ttl: 60 }, () => [
              path.json("/api/data", () => ({ ok: true }), {
                name: "api.data",
              }),
            ]),
            path.text("/old/", () => "old", {
              name: "old",
              trailingSlash: "always",
            }),
          ]),
        );

      const json = await evaluate(ssr, "dispatch /api/data", () =>
        testing.dispatch(router, { request: "/api/data" }),
      );
      expect(json.status).toBe(200);
      expect(await json.json()).toEqual({ ok: true });
      const partial = await evaluate(ssr, "dispatch /old?_rsc_partial", () =>
        testing.dispatch(router, { request: "/old?_rsc_partial=1" }),
      );
      expect(partial.status).toBe(204);
      expect(pluginRscModules(ssr)).toEqual([]);
    },
  );
});
