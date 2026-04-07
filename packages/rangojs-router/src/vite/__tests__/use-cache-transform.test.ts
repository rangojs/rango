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
    ).rejects.toThrow(/non-function export.*"VERSION"/);
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
    ).rejects.toThrow(/non-function exports.*"A".*"B"/);
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
});
