import { describe, it, expect, vi } from "vitest";

// Exercises the file-level filter's `isFunction !== true` branch for the
// statically-indeterminate case (meta.isFunction === undefined). The pinned
// @vitejs/plugin-rsc always returns a concrete boolean, so no real source can
// reach this branch today; #1246 makes call-expression initializers report
// undefined. We mock the plugin-rsc transforms boundary to drive the filter
// with undefined and assert the export is rejected at build. Under the old
// `=== false` guard this export would pass the filter and be wrapped, so this
// test fails if the guard regresses.
vi.mock("@vitejs/plugin-rsc/transforms", () => {
  const output = {
    prepend: () => {},
    overwrite: () => {},
    toString: () => "wrapped",
    generateMap: () => ({}),
  };
  return {
    hasDirective: () => true,
    transformHoistInlineDirective: () => ({ output, names: [] }),
    transformWrapExport: (
      _code: string,
      _ast: unknown,
      opts: {
        filter: (name: string, meta: { isFunction?: boolean }) => boolean;
      },
    ) => {
      // Mimic plugin-rsc invoking the filter once per export: the first is
      // statically indeterminate (a call-expression initializer post-#1246),
      // the second a confirmed function.
      opts.filter("handler", { isFunction: undefined });
      opts.filter("getData", { isFunction: true });
      return { exportNames: ["getData"], output };
    },
  };
});

import { useCacheTransform } from "../plugins/use-cache-transform.js";

function initPlugin() {
  const plugin = useCacheTransform();
  const p = plugin as typeof plugin & {
    configResolved: (config: { command: string; root: string }) => void;
    transform: (this: unknown, code: string, id: string) => unknown;
  };
  p.configResolved({ command: "serve", root: "/project" });
  return p;
}

describe("use-cache-transform: statically-indeterminate export (plugin-rsc #1246)", () => {
  it("rejects an export whose isFunction is undefined, not only === false", async () => {
    const plugin = initPlugin();

    const code = `"use cache";\nexport const handler = makeHandler();\nexport async function getData() { return 42; }`;

    await expect(
      plugin.transform.call(
        { environment: { name: "rsc" } },
        code,
        "/project/src/factory.ts",
      ),
    ).rejects.toThrow(/statically-confirmed functions.*"handler"/);
  });
});
