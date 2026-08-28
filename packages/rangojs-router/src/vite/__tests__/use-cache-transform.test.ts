import { describe, it, expect } from "vitest";
import { useCacheTransform } from "../plugins/use-cache-transform.js";

function createPlugin(opts: { command?: string; root?: string } = {}) {
  const plugin = useCacheTransform();
  return plugin as typeof plugin & {
    configResolved: (config: any) => void;
    transform: (this: any, code: string, id: string) => any;
  };
}

function initPlugin(opts: { command?: string; root?: string } = {}) {
  const plugin = createPlugin(opts);
  plugin.configResolved({
    command: opts.command ?? "serve",
    root: opts.root ?? "/project",
  });
  return plugin;
}

const rscEnv = { name: "rsc" };

describe("use-cache-transform: file-level non-function exports", () => {
  it("throws on non-function exports with file-level 'use cache'", async () => {
    const plugin = initPlugin();

    const code = `"use cache";\nexport const VERSION = 1;\nexport async function getData() { return 42; }`;

    await expect(
      plugin.transform.call(
        { environment: rscEnv },
        code,
        "/project/src/data.ts",
      ),
    ).rejects.toThrow(/statically-confirmed functions.*"VERSION"/);
  });

  it("throws listing all non-function exports", async () => {
    const plugin = initPlugin();

    const code = `"use cache";\nexport const A = 1;\nexport const B = "hello";\nexport async function fn() {}`;

    await expect(
      plugin.transform.call(
        { environment: rscEnv },
        code,
        "/project/src/multi.ts",
      ),
    ).rejects.toThrow(/statically-confirmed functions.*"A".*"B"/);
  });

  it("throws on a factory/HOF export (statically indeterminate function)", async () => {
    // Deliberate policy (2026-06-14): file-level "use cache" wraps only
    // statically-confirmed functions, so a factory/HOF export is rejected at
    // build even though it returns a function at runtime. The user rewrites it
    // as a direct async function. A call-expression initializer is reported
    // isFunction:false by the pinned plugin-rsc and isFunction:undefined after
    // #1246; `isFunction !== true` rejects it in both versions. (Also a bump
    // regression guard: the pre-fix `=== false` guard would wrap it once the
    // value becomes undefined.)
    const plugin = initPlugin();

    const code = `"use cache";\nexport const getUser = withCache(fetchUser);\nexport async function getData() { return 42; }`;

    await expect(
      plugin.transform.call(
        { environment: rscEnv },
        code,
        "/project/src/factory.ts",
      ),
    ).rejects.toThrow(/statically-confirmed functions.*"getUser"/);
  });

  it("allows file-level 'use cache' when all exports are functions", async () => {
    const plugin = initPlugin();

    const code = `"use cache";\nexport async function getData() { return 42; }\nexport async function getUser() { return "user"; }`;

    const result = await plugin.transform.call(
      { environment: rscEnv },
      code,
      "/project/src/all-fns.ts",
    );

    // Should succeed and produce wrapped output
    expect(result).toBeDefined();
    expect(result.code).toContain("__rango_registerCachedFunction");
  });

  it("skips non-rsc environment", async () => {
    const plugin = initPlugin();

    const code = `"use cache";\nexport const VERSION = 1;`;

    const result = await plugin.transform.call(
      { environment: { name: "client" } },
      code,
      "/project/src/data.ts",
    );

    expect(result).toBeUndefined();
  });

  it("skips inline 'use server' exports in a file-level 'use cache' module", async () => {
    const plugin = initPlugin();

    const code = `"use cache";
export async function getData() { return 42; }
export async function save() {
  "use server";
  return "saved";
}
`;

    const result = await plugin.transform.call(
      { environment: rscEnv },
      code,
      "/project/src/mixed.ts",
    );

    expect(result).toBeDefined();
    expect(result.code).toContain("__rango_registerCachedFunction");
    expect(result.code).toMatch(/__rango_registerCachedFunction\(\s*getData/);
    expect(result.code).not.toMatch(/__rango_registerCachedFunction\(\s*save/);
  });

  it("skips the registerServerReference rebind plugin-rsc leaves for a hoisted 'use server' export", async () => {
    // In the real RSC pipeline plugin-rsc's use-server transform (normal
    // enforce) runs BEFORE this plugin (enforce: "post"), so the mixed module
    // arrives post-hoist: the inline "use server" body becomes a $$hoist_*
    // export and the original name is rebound to a registerServerReference
    // call expression. Run the real transform to pin that shape.
    const { parseAstAsync } = await import("vite");
    const { transformServerActionServer } =
      await import("@vitejs/plugin-rsc/transforms");
    const src = `"use cache";
export async function getData() { return 42; }
export async function save() {
  "use server";
  return "saved";
}
`;
    const ast = await parseAstAsync(src);
    const hoistResult = transformServerActionServer(src, ast, {
      runtime: (value: string, name: string) =>
        `$$ReactServer.registerServerReference(${value}, "testRef", ${JSON.stringify(name)})`,
      rejectNonAsyncFunction: true,
    });
    expect(hoistResult.output.hasChanged()).toBe(true);
    const hoisted = hoistResult.output.toString();
    expect(hoisted).toContain("$$hoist_0_save");

    const plugin = initPlugin();
    const result = await plugin.transform.call(
      { environment: rscEnv, warn: () => {} },
      hoisted,
      "/project/src/mixed-post-hoist.ts",
    );

    expect(result).toBeDefined();
    const wraps = result.code.match(/__rango_registerCachedFunction\(/g) ?? [];
    expect(wraps).toHaveLength(1);
    expect(result.code).toMatch(/__rango_registerCachedFunction\(\s*getData/);
  });

  it("hoists inline 'use cache' inside a file-level 'use server' module", async () => {
    const plugin = initPlugin();

    const code = `"use server";
export async function save() { return "saved"; }
export async function getCached() {
  "use cache";
  return 42;
}
`;

    const result = await plugin.transform.call(
      { environment: rscEnv, warn: () => {} },
      code,
      "/project/src/server-mixed.ts",
    );

    expect(result).toBeDefined();
    expect(result.code).toContain("__rango_registerCachedFunction");
    expect(result.code).toContain("use cache");
  });

  it("hoists inline 'use cache' next to a sibling function that starts with an expression", async () => {
    // plugin-rsc 0.5.34 matchDirective throws on `directive: null` (Vite/oxc
    // parseAst) when walking a sibling handler after a successful hoist.
    const plugin = initPlugin();

    const code = `async function getTaggedItem(id) {
  "use cache";
  return { ts: Date.now(), id };
}
export async function other(ctx) {
  await Promise.resolve();
  return getTaggedItem(ctx.id);
}
`;

    const result = await plugin.transform.call(
      { environment: rscEnv, warn: () => {} },
      code,
      "/project/src/cache-tag-like.ts",
    );

    expect(result).toBeDefined();
    expect(result.code).toContain("__rango_registerCachedFunction");
    expect(result.code).toContain("$$hoist_0_getTaggedItem");
  });

  it("hoists an inline 'use cache' method", async () => {
    const plugin = initPlugin();

    const code = `export const api = {
  async getData() {
    "use cache";
    return 42;
  }
};
`;

    const result = await plugin.transform.call(
      { environment: rscEnv, warn: () => {} },
      code,
      "/project/src/methods.ts",
    );

    expect(result).toBeDefined();
    expect(result.code).toContain("__rango_registerCachedFunction");
  });
});
