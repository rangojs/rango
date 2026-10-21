/**
 * plugin-rsc's production server-reference map, rewritten so neither the map
 * nor an entry inherits a name. Cases evaluate the module and index it as
 * plugin-rsc's runtime does.
 */
import { describe, expect, it } from "vitest";
import { SERVER_REFERENCES_MODULE_ID } from "../discovery/build-versions.js";
import {
  nullPrototypeServerReferences,
  serverReferencesNullPrototype,
} from "../plugins/server-references-null-prototype.js";
import { sortDefaultExportProperties } from "../plugins/stable-rsc-output.js";
import { pluginRscServerReferences } from "./helpers/plugin-rsc-server-references.js";

const saveCart = (): string => "saved";
const defaultAction = (): string => "default";
/** A module namespace, which has no prototype. */
const CART = Object.assign(Object.create(null), {
  saveCart,
  default: defaultAction,
});
const METAS = [
  { referenceKey: "f0", importId: "/src/cart.ts", exportNames: ["saveCart"] },
  {
    referenceKey: "0a",
    importId: "/src/cart.ts",
    exportNames: ["saveCart", "default"],
  },
];
const CODE = pluginRscServerReferences(METAS);
const UNKNOWN_SHAPE =
  /^virtual:vite-rsc\/server-references: expected [^]* Report it with the plugin-rsc version\.$/;

type Entry = Record<string, unknown>;

/** Evaluate `code`; throws unless the map and every entry have no prototype. */
async function nullPrototypeEntries(code: string): Promise<Entry[]> {
  const references: Record<string, () => Promise<Entry>> = new Function(
    "__import",
    code.replace("export default", "return").replaceAll("import(", "__import("),
  )(async () => CART);
  expect(Object.getPrototypeOf(references)).toBeNull();
  const entries = await Promise.all(
    Object.values(references).map((load) => load()),
  );
  for (const entry of entries) expect(Object.getPrototypeOf(entry)).toBeNull();
  return entries;
}

const rewrite = (code: string): string => nullPrototypeServerReferences(code)!;

describe("nullPrototypeServerReferences", () => {
  it("gives the map and each entry a null prototype, keeping their exports", async () => {
    expect(await nullPrototypeEntries(rewrite(CODE))).toEqual([
      { saveCart },
      { default: defaultAction, saveCart },
    ]);
  });

  it("rewrites the empty map", async () => {
    expect(await nullPrototypeEntries(rewrite("export default {};\n"))).toEqual(
      [],
    );
  });

  it("leaves a map that already has a null prototype", () => {
    expect(nullPrototypeServerReferences(rewrite(CODE))).toBeUndefined();
    const quoted = `export default {"__proto__": null, "k": async () => { const {a} = await import("/a.ts"); return {"__proto__": null, a}; }};`;
    expect(nullPrototypeServerReferences(quoted)).toBeUndefined();
  });

  it.each([
    ["tabs", CODE.replaceAll("  ", "\t")],
    ["single-line", CODE.replaceAll("\n", " ")],
    [
      "commented",
      CODE.replace("{", "{ // map\n").replaceAll(
        "return {",
        "return /* exports */ {",
      ),
    ],
    ["unquoted-key", CODE.replace('"f0":', "f0:")],
    [
      "function-expression",
      CODE.replaceAll("async () =>", "async function ()"),
    ],
  ])("rewrites the %s variant", async (_, code) => {
    expect(await nullPrototypeEntries(rewrite(code))).toHaveLength(2);
  });

  it("leaves an entry that returns a bare import(), a module namespace", async () => {
    const lazy = `  "k": () => import("/src/cart.ts"),\n  "j": async () => { return await import("/src/cart.ts"); },\n`;
    const output = rewrite(CODE.replace("{", `{\n${lazy}`));
    expect(output).toContain(lazy);
    expect(await nullPrototypeEntries(output)).toHaveLength(4);
  });

  it("throws on any other shape", () => {
    for (const code of [
      "export {}",
      "this is not javascript {",
      "export default { ...other };",
      `export default { "k": load };`,
      `export default { "k": () => import("/a.ts").then((m) => m) };`,
      `export default { "k": async () => { const m = await import("/a.ts"); return m; } };`,
      `export default { "k": async () => { if (x) return {}; return {}; } };`,
    ]) {
      expect(() => nullPrototypeServerReferences(code)).toThrow(UNKNOWN_SHAPE);
    }
  });

  it("stays null-prototype and stable through stable-rsc-output.ts's sort", async () => {
    const one = sortDefaultExportProperties(rewrite(CODE))!;
    const other = sortDefaultExportProperties(
      rewrite(pluginRscServerReferences([...METAS].reverse())),
    );
    expect(one).toBe(other);
    expect(one).toMatch(
      /^export default \{"0a": [^]*\n__proto__: null,\n"f0": /,
    );
    expect(await nullPrototypeEntries(one)).toHaveLength(2);
  });
});

describe("serverReferencesNullPrototype", () => {
  const plugin = serverReferencesNullPrototype() as any;

  it("transforms only the module, before plugin-rsc's post transforms", () => {
    const ids = [
      SERVER_REFERENCES_MODULE_ID,
      "virtual:vite-rsc/server-references",
      `${SERVER_REFERENCES_MODULE_ID}?x`,
      `/src${SERVER_REFERENCES_MODULE_ID}`,
    ];
    expect(ids.map((id) => plugin.transform.filter.id.test(id))).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect({ apply: plugin.apply, enforce: plugin.enforce }).toEqual({
      apply: "build",
      enforce: undefined,
    });
    expect(plugin.applyToEnvironment({ name: "rsc" })).toBe(true);
    expect(plugin.applyToEnvironment({ name: "ssr" })).toBe(false);
  });

  it("fails an RSC build that never loaded the module", () => {
    plugin.buildStart();
    expect(plugin.transform.handler(CODE).code).toBe(rewrite(CODE));
    expect(() => plugin.buildEnd()).not.toThrow();
    plugin.buildStart();
    expect(() => plugin.buildEnd()).toThrow(
      /^The RSC build never loaded virtual:vite-rsc\/server-references: [^]* Report it with the plugin-rsc version\.$/,
    );
    expect(() => plugin.buildEnd(new Error("failed build"))).not.toThrow();
  });
});
