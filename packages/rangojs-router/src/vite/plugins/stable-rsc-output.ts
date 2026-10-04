import { parseAst, type Plugin } from "vite";
import { escapeRegExp } from "../../regex-escape.js";
import { compareStrings } from "../utils/compare-strings.js";
import { SERVER_REFERENCES_MODULE_ID } from "../discovery/build-versions.js";

/** One property of an object literal, by its position in the source. */
export interface LiteralProperty {
  readonly key: string;
  /** Range of the whole property, key included. */
  readonly start: number;
  readonly end: number;
  /** The value's AST node. */
  readonly value: any;
}

/**
 * The properties of an object-literal AST node, or undefined when it is not an
 * object literal of plain keys (a spread, a computed key).
 */
export function literalProperties(object: any): LiteralProperty[] | undefined {
  if (object?.type !== "ObjectExpression") return undefined;
  const properties: LiteralProperty[] = [];
  for (const property of object.properties ?? []) {
    const key =
      property?.type === "Property" && !property.computed
        ? (property.key?.value ?? property.key?.name)
        : undefined;
    if (typeof key !== "string") return undefined;
    properties.push({
      key,
      start: property.start,
      end: property.end,
      value: property.value,
    });
  }
  return properties;
}

/**
 * The properties of a module's `export default { ... }`, or undefined when
 * the module does not parse or is not that shape. plugin-rsc generates its
 * registries (the server-reference map, the assets manifest) in this form.
 */
export function defaultExportProperties(
  code: string,
): LiteralProperty[] | undefined {
  let program: any;
  try {
    program = parseAst(code);
  } catch {
    return undefined;
  }
  return literalProperties(
    (program.body ?? []).find(
      (node: any) => node?.type === "ExportDefaultDeclaration",
    )?.declaration,
  );
}

/**
 * Return `code` with the properties of its default-exported object literal
 * sorted by key, or undefined when there is nothing to reorder (or the module
 * is not that shape).
 */
export function sortDefaultExportProperties(code: string): string | undefined {
  const properties = defaultExportProperties(code);
  if (!properties || properties.length < 2) return undefined;
  const sorted = [...properties].sort((a, b) => compareStrings(a.key, b.key));
  if (sorted.every((property, index) => property === properties[index])) {
    return undefined;
  }
  return (
    code.slice(0, properties[0]!.start) +
    sorted
      .map((property) => code.slice(property.start, property.end))
      .join(",\n") +
    code.slice(properties[properties.length - 1]!.end)
  );
}

const ASSETS_MANIFEST_ID = "virtual:vite-rsc/assets-manifest";
const ASSETS_MANIFEST_IMPORT =
  /import\s+([A-Za-z_$][\w$]*)\s+from\s*["']virtual:vite-rsc\/assets-manifest["']/;
/** The local name plugin-rsc's own runtime modules import the manifest under. */
const ASSETS_MANIFEST_BINDING = "assetsManifest";
/**
 * The names plugin-rsc's GENERATED code imports it under. Only these are
 * renamed: the rename is textual, and a name an app author picked
 * (`import manifest from ...`) can also be a word in that module's strings.
 */
const GENERATED_BINDINGS: ReadonlySet<string> = new Set([
  "__vite_rsc_assets_manifest__",
  "__vite_rsc_assets_manifest",
]);

function identifier(name: string): RegExp {
  return new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])`, "g");
}

/**
 * Return `code` with its default import of plugin-rsc's assets manifest
 * renamed to {@link ASSETS_MANIFEST_BINDING}, or undefined when there is
 * nothing to rename (no such import under a generated name, or the module
 * uses the canonical name for something else).
 */
export function canonicalAssetsManifestBinding(
  code: string,
): string | undefined {
  const local = code.match(ASSETS_MANIFEST_IMPORT)?.[1];
  if (local === undefined || !GENERATED_BINDINGS.has(local)) return undefined;
  if (identifier(ASSETS_MANIFEST_BINDING).test(code)) return undefined;
  return code.replace(identifier(local), ASSETS_MANIFEST_BINDING);
}

/**
 * Removes two run-to-run differences from plugin-rsc 0.5.35's build output.
 * The cache versions hash these bytes (discovery/build-versions.ts).
 *
 * 1. Property order of the server-reference map. plugin-rsc writes it in the
 *    order its transforms first saw each `"use server"` module
 *    (`ServerReferencesManager.claimMap`), which varies with the concurrent
 *    scan builds (e2e/test-app: 2 of 2 consecutive builds differed). Sorted
 *    here so a minified server build, where stripServerReferenceMap finds no
 *    region comments, still hashes the same bytes.
 * 2. Local name of the assets-manifest import. plugin-rsc imports the manifest
 *    under three names; the bundler merges them into one import per chunk and
 *    keeps a different one from build to build (the cache-versions fixture:
 *    1 of 10 concurrent builds). One name in, one name out.
 * @internal
 */
export function stableRscOutput(): Plugin {
  return {
    name: "@rangojs/router:stable-rsc-output",
    apply: "build",
    // After plugin-rsc's transforms, which add the manifest import.
    enforce: "post",
    transform(code, id) {
      const stable =
        id === SERVER_REFERENCES_MODULE_ID
          ? sortDefaultExportProperties(code)
          : code.includes(ASSETS_MANIFEST_ID)
            ? canonicalAssetsManifestBinding(code)
            : undefined;
      return stable === undefined ? null : { code: stable, map: null };
    },
  };
}
