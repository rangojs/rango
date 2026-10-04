/**
 * Two things plugin-rsc's build output does differently from one build of the
 * same source to the next, fixed here because the cache versions hash that
 * output: the order of its server-reference map, and the local name of its
 * assets-manifest import.
 */
import { describe, expect, it } from "vitest";
import { SERVER_REFERENCES_MODULE_ID } from "../discovery/build-versions.js";
import {
  canonicalAssetsManifestBinding,
  sortDefaultExportProperties,
  stableRscOutput,
} from "../plugins/stable-rsc-output.js";

/** The module as plugin-rsc 0.5.35 generates it, for `ids` in that order. */
function serverReferencesModule(ids: string[]): string {
  let code = "";
  for (const id of ids) {
    code += `
  ${JSON.stringify(id)}: async () => {
    const {run} = await import(${JSON.stringify(`/src/${id}.ts`)});
    return {run};
  },
`;
  }
  return `export default {${code}};\n`;
}

function evaluate(code: string): Record<string, unknown> {
  // The map's values are thunks; only the keys and their order matter here.
  return new Function(
    `return (${code.replace("export default", "").replace(/;\s*$/, "")})`,
  )();
}

describe("sortDefaultExportProperties", () => {
  it("gives two orders of the same entries the same source", () => {
    const one = sortDefaultExportProperties(
      serverReferencesModule(["cefd", "ba51", "0a00"]),
    );
    const other = sortDefaultExportProperties(
      serverReferencesModule(["ba51", "0a00", "cefd"]),
    );
    expect(one).toBeDefined();
    expect(one).toBe(other);
    expect(Object.keys(evaluate(one!))).toEqual(["0a00", "ba51", "cefd"]);
  });

  it("keeps every entry's body", () => {
    const sorted = sortDefaultExportProperties(
      serverReferencesModule(["b", "a"]),
    )!;
    expect(sorted).toContain(`await import("/src/a.ts")`);
    expect(sorted).toContain(`await import("/src/b.ts")`);
  });

  it("returns undefined when the order is already sorted", () => {
    expect(
      sortDefaultExportProperties(serverReferencesModule(["a", "b"])),
    ).toBeUndefined();
  });

  it("leaves other module shapes alone", () => {
    expect(sortDefaultExportProperties("export {}")).toBeUndefined();
    expect(sortDefaultExportProperties("export default {};\n")).toBeUndefined();
    expect(
      sortDefaultExportProperties("export default { ...a, b: 1 };"),
    ).toBeUndefined();
    expect(
      sortDefaultExportProperties("export default { [k]: 1, b: 2 };"),
    ).toBeUndefined();
    expect(sortDefaultExportProperties("this is not javascript {")).toBe(
      undefined,
    );
  });
});

describe("stableRscOutput", () => {
  const plugin = stableRscOutput() as unknown as {
    transform: (code: string, id: string) => { code: string } | null;
  };

  it("sorts plugin-rsc's server-reference module", () => {
    const result = plugin.transform(
      serverReferencesModule(["b", "a"]),
      SERVER_REFERENCES_MODULE_ID,
    );
    expect(Object.keys(evaluate(result!.code))).toEqual(["a", "b"]);
  });

  it("touches no other module", () => {
    expect(
      plugin.transform(serverReferencesModule(["b", "a"]), "/src/app.ts"),
    ).toBeNull();
  });

  it("leaves the dev module (no map) alone", () => {
    expect(
      plugin.transform("export {}", SERVER_REFERENCES_MODULE_ID),
    ).toBeNull();
  });

  it("renames the assets-manifest import of a module plugin-rsc generated", () => {
    const result = plugin.transform(
      SERVER_CSS_MODULE,
      "\0virtual:vite-rsc/css?type=rsc&id=%2Fapp%2Fsrc%2Fnote.tsx&lang.js",
    );
    expect(result!.code).toContain(
      'import assetsManifest from "virtual:vite-rsc/assets-manifest";',
    );
    expect(result!.code).toContain(
      'assetsManifest.serverResources["src/note.tsx"]',
    );
    expect(result!.code).not.toContain("__vite_rsc_assets_manifest__");
  });

  it("runs after plugin-rsc's transforms, in a build only", () => {
    const { apply, enforce } = stableRscOutput();
    expect({ apply, enforce }).toEqual({ apply: "build", enforce: "post" });
  });
});

/** The module plugin-rsc 0.5.35 generates for a server component's CSS. */
const SERVER_CSS_MODULE = `
import __vite_rsc_assets_manifest__ from "virtual:vite-rsc/assets-manifest";
import __vite_rsc_react__ from "react";
export const Resources = (fn)(
  __vite_rsc_react__,
  __vite_rsc_assets_manifest__.serverResources["src/note.tsx"],
);
`;

describe("canonicalAssetsManifestBinding", () => {
  it("renames every reference to the import", () => {
    const code = canonicalAssetsManifestBinding(
      `import __vite_rsc_assets_manifest from "virtual:vite-rsc/assets-manifest";\n` +
        `const a = __vite_rsc_assets_manifest.bootstrapScriptContent;\n` +
        `const b = [__vite_rsc_assets_manifest];`,
    )!;
    expect(code).toBe(
      `import assetsManifest from "virtual:vite-rsc/assets-manifest";\n` +
        `const a = assetsManifest.bootstrapScriptContent;\n` +
        `const b = [assetsManifest];`,
    );
  });

  it("does not touch a longer identifier or a property of that name", () => {
    const code = canonicalAssetsManifestBinding(
      `import __vite_rsc_assets_manifest from "virtual:vite-rsc/assets-manifest";\n` +
        `const x__vite_rsc_assets_manifest = __vite_rsc_assets_manifest.x; ` +
        `const $__vite_rsc_assets_manifest = 1; o.__vite_rsc_assets_manifest;`,
    )!;
    expect(code).toContain(
      "const x__vite_rsc_assets_manifest = assetsManifest.x;",
    );
    expect(code).toContain("const $__vite_rsc_assets_manifest = 1;");
    expect(code).toContain("o.__vite_rsc_assets_manifest;");
  });

  // The rename is textual: a name an app author picked can also be a word in
  // that module's markup (`rel="manifest"`), so only plugin-rsc's generated
  // names are renamed.
  it("leaves an import under a name plugin-rsc did not generate", () => {
    expect(
      canonicalAssetsManifestBinding(
        `import manifest from "virtual:vite-rsc/assets-manifest";\n` +
          `const link = '<link rel="manifest" href="/manifest.json">'; manifest.x;`,
      ),
    ).toBeUndefined();
  });

  it("leaves the name plugin-rsc's runtime already uses", () => {
    expect(
      canonicalAssetsManifestBinding(
        `import assetsManifest from "virtual:vite-rsc/assets-manifest";\nassetsManifest.x;`,
      ),
    ).toBeUndefined();
  });

  it("leaves a module that uses the canonical name for something else", () => {
    expect(
      canonicalAssetsManifestBinding(
        `import __vite_rsc_assets_manifest from "virtual:vite-rsc/assets-manifest";\n` +
          `const assetsManifest = 1; __vite_rsc_assets_manifest.x;`,
      ),
    ).toBeUndefined();
  });

  it("leaves a module without the import", () => {
    expect(
      canonicalAssetsManifestBinding(`export const a = 1;`),
    ).toBeUndefined();
  });
});
