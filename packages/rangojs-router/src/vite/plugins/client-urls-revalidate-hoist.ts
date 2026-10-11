import type { Plugin } from "vite";
import { normalizePath, parseAst } from "vite";
import MagicString from "magic-string";
import { createHash } from "node:crypto";
import { relative } from "node:path";
import { hasDirective } from "@vitejs/plugin-rsc/transforms";
import { HOISTED_REVALIDATE_KEY } from "../../client-urls/hoisted-revalidate.js";
import { hasUseClientDirective } from "../utils/directive-prologue.js";
import { offsetToLineColumn } from "./expose-ids/export-analysis.js";
import {
  analyzeScopes,
  collectImports,
  TYPE_KEYS,
  type ImportBinding,
  type Node,
} from "./hoist/scope.js";
import {
  collectFreeReferences,
  emitImports,
  findHelperCalls,
  findLexicalCapture,
  isFunctionLiteral,
  parseLang,
  unwrapExpression,
  type LexicalCaptureMessages,
} from "./hoist/literal.js";
import {
  loadEmittedOrDisk,
  readSource,
  recordEmitted,
  resolveSourceTarget,
  SOURCE_FILE_RE,
  type EmittedEntry,
} from "./hoist/source.js";

/**
 * clientUrls() loader `revalidate()` runs on the server, with the arguments a
 * urls() loader's predicate gets. The predicate is declared in a
 * "use client" module, so the build moves it into a server module (the
 * reverse of transition-when-hoist.ts):
 *
 *   loader(CartLoader, () => [
 *     revalidate((ctx) => ctx.isAction(Cart) ? ctx.actionResult?.ok : undefined),
 *   ])
 *
 * becomes, in the client and SSR copies of the module,
 *
 *   loader(CartLoader, () => [revalidate({ $$rangoRevalidate: "<key>" })])
 *
 * and `<file>?rango-revalidate` (a query on the file itself, so relative
 * imports resolve as they did there and an edit invalidates it) is
 *
 *   import { registerClientUrlRevalidators } from "@rangojs/router/server";
 *   <the module-level imports the predicates reference>
 *   registerClientUrlRevalidators({ "<key>": (ctx) => ... });
 *
 * plugin-rsc replaces the RSC copy of a "use client" module with client
 * reference proxies and drops everything else, so a post transform appends
 * `import "<file>?rango-revalidate"` to the proxy: the predicates register
 * when the group's module loads on the server (a lazy include stays lazy).
 * Route discovery serializes the SSR copy, so the projection carries the
 * keys; materialization (client-urls/server-projection.ts) attaches the
 * registered predicates to the loader stubs.
 *
 * A key hashes the project-relative file and the predicate's syntax tree
 * (formatting, comments and TypeScript excluded, so a re-printing transform
 * in one environment keeps it): two environments that saw a different
 * predicate fail loudly at materialization instead of pairing a loader with
 * the wrong one.
 *
 * Keyed on calls of the `revalidate` helper a clientUrls() builder callback
 * receives (destructured, renamed, or as `helpers.revalidate`), with
 * clientUrls imported from "@rangojs/router/client". The argument may
 * reference imports and globals only: a binding of the module or of an
 * enclosing function, `this`/`arguments`/`super`/`new.target`, `import()`,
 * `import.meta` other than `import.meta.env`, a browser-only global, an
 * `async` or generator function, or an import of a "use client" module is a
 * LOUD error naming file:line. Imports stay in the "use client" module too
 * (they are not pruned). Vitest does not run the plugin, so in unit tests the
 * predicate stays a plain function.
 */

const CLIENT_URLS_REVALIDATE_QUERY = "rango-revalidate";
const REGISTER = "__rango_registerClientUrlRevalidators";

const CLIENT_SOURCES: ReadonlySet<string> = new Set(["@rangojs/router/client"]);

const BROWSER_GLOBALS: ReadonlySet<string> = new Set([
  "window",
  "document",
  "navigator",
  "localStorage",
  "sessionStorage",
  "location",
  "history",
]);

const NOT_A_FUNCTION = new Set([
  "ObjectExpression",
  "ArrayExpression",
  "Literal",
  "TemplateLiteral",
  "ClassExpression",
]);

const CAPTURE_MESSAGES: LexicalCaptureMessages = {
  lexical: {
    this: "`this` in an arrow is the enclosing function's `this`.",
    arguments: "`arguments` in an arrow is the enclosing function's.",
    super: "`super` refers to the enclosing object.",
    "new.target": "`new.target` in an arrow is the enclosing function's.",
  },
  captureHint: "Read what you need from the predicate's argument.",
  loadsHint: "Import server-safe modules statically.",
  importMetaWhy: 'is the "use client" module\'s.',
  importMetaMemberWhy:
    'is resolved against the "use client" module; only `import.meta.env` ' +
    "is available to a hoisted predicate.",
  dynamicImportWhy:
    "loads a module at run time, which the build cannot check is server-safe.",
};

// Cheap pre-filter: every site needs clientUrls imported from the router and
// a `revalidate` helper. The AST walk is the authority.
const CLIENT_IMPORT_RE = /["']@rangojs\/router\/client["']/;
const REVALIDATE_RE = /\brevalidate\b/;

function revalidateError(
  file: string,
  code: string,
  node: Node,
  detail: string,
): Error {
  const { line, column } = offsetToLineColumn(code, node.start);
  return new Error(
    `[rango] clientUrls() revalidate() at ${file}:${line}:${column}: ` +
      `revalidate() runs on the server; ${detail}`,
  );
}

/** Fields that change with formatting, comments or TS stripping. */
const FINGERPRINT_SKIP: ReadonlySet<string> = new Set([
  "type",
  "start",
  "end",
  "loc",
  "range",
  "raw",
  "extra",
  "shorthand",
  // TS-only flags (`let x!: T`), lost with the types.
  "definite",
  ...TYPE_KEYS,
]);

/**
 * The predicate's syntax tree, serialized without what a re-printing
 * transform changes: whitespace, comments, parentheses, quotes, shorthand
 * properties and TypeScript. plugin-react's React Compiler re-prints a
 * "use client" module in the client and SSR environments only, so a key over
 * the source text would differ from the RSC environment's.
 */
function fingerprint(node: Node): string {
  const out: string[] = [];
  const visit = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      out.push("[");
      for (const item of value) visit(item);
      out.push("]");
      return;
    }
    if (typeof value !== "object") {
      out.push(JSON.stringify(typeof value === "bigint" ? `${value}n` : value));
      return;
    }
    let entry = value as Node;
    if (typeof entry.type === "string") {
      entry = unwrapExpression(entry);
      // Type-only syntax; an instantiation `f<T>` keeps its expression.
      if (entry.type.startsWith("TS")) {
        visit(entry.expression);
        return;
      }
      out.push(entry.type, "(");
    }
    for (const key of Object.keys(entry)) {
      if (FINGERPRINT_SKIP.has(key)) continue;
      // `x?: T` loses its `?` with its type; `a?.b` keeps it.
      if (key === "optional" && entry.type === "Identifier") continue;
      out.push(key);
      visit(entry[key]);
    }
    if (typeof entry.type === "string") out.push(")");
  };
  visit(node);
  return out.join(" ");
}

function keyOf(relativeFile: string, predicate: Node): string {
  return createHash("sha256")
    .update(relativeFile)
    .update("\0")
    .update(fingerprint(predicate))
    .digest("hex")
    .slice(0, 12);
}

/**
 * The key of the predicate `source` declared in `relativeFile` (relative to
 * the project root): a hash of the file and the predicate's syntax, so the
 * same predicate gets one key in every environment and however it is
 * formatted.
 */
export function revalidateKey(relativeFile: string, source: string): string {
  const program: Node = parseAst(`(${source});`, { lang: "tsx" });
  return keyOf(relativeFile, unwrapExpression(program.body[0].expression));
}

interface HoistClientUrlsRevalidateDeps {
  /** Project root: keys hash the file relative to it. */
  readonly root: string;
  /**
   * Whether a module a predicate imports is a "use client" module beyond its
   * specifier (the plugin resolves it and reads its directive prologue).
   */
  isClientModule?(source: string): Promise<boolean> | boolean;
}

interface HoistClientUrlsRevalidateResult {
  /** The module with each predicate replaced by its marker. */
  readonly code: string;
  readonly map: ReturnType<MagicString["generateMap"]>;
  /** The server module that registers every hoisted predicate. */
  readonly module: string;
  /** The keys, in declaration order, duplicates removed. */
  readonly keys: readonly string[];
}

/**
 * Hoist every clientUrls() `revalidate()` predicate of a "use client"
 * module. Returns null when there is none. Throws, naming file:line, for a
 * predicate that is not pure.
 */
export async function hoistClientUrlsRevalidates(
  code: string,
  id: string,
  deps: HoistClientUrlsRevalidateDeps,
): Promise<HoistClientUrlsRevalidateResult | null> {
  if (!CLIENT_IMPORT_RE.test(code) || !REVALIDATE_RE.test(code)) return null;
  const file = normalizePath(id.split("?", 1)[0]!);
  let program: Node;
  try {
    program = parseAst(code, { lang: parseLang(file) });
  } catch {
    return null;
  }
  if (!hasDirective(program.body, "use client")) return null;

  const { moduleScope, references, scopeOf } = analyzeScopes(program);
  const imports = collectImports(program);
  const calls = findHelperCalls(program, scopeOf, moduleScope, imports, {
    sources: CLIENT_SOURCES,
    builder: "clientUrls",
    helper: "revalidate",
    directImport: false,
  });
  if (calls.length === 0) return null;

  const relativeFile = normalizePath(relative(deps.root, file));
  const s = new MagicString(code);
  const used = new Map<string, boolean>();
  const entries = new Map<string, string>();

  for (const { call } of calls) {
    const [arg, extra] = call.arguments;
    if (!arg || extra || arg.type === "SpreadElement") {
      throw revalidateError(
        file,
        code,
        call,
        "`revalidate()` takes exactly one predicate.",
      );
    }
    const value = unwrapExpression(arg);
    if (NOT_A_FUNCTION.has(value.type)) {
      throw revalidateError(
        file,
        code,
        value,
        "`revalidate()` expects a predicate function.",
      );
    }
    if (isFunctionLiteral(value) && (value.async || value.generator)) {
      throw revalidateError(
        file,
        code,
        value,
        `a${value.async ? "n `async`" : " generator"} function returns ` +
          `${value.async ? "a Promise" : "an iterator"}, which the router ` +
          "ignores: return a boolean, `{ defaultShouldRevalidate }`, or " +
          "nothing.",
      );
    }

    const lexical = findLexicalCapture(
      value,
      references,
      code,
      CAPTURE_MESSAGES,
    );
    if (lexical)
      throw revalidateError(file, code, lexical.node, lexical.detail);

    const free = collectFreeReferences(value, references, moduleScope, imports);
    const binding = free.bindings[0];
    if (binding) {
      const name = binding.node.name;
      throw revalidateError(
        file,
        code,
        binding.node,
        binding.scope.lookup(name) === moduleScope
          ? `\`${name}\` is declared in this "use client" module. Move the ` +
              'predicate to its own module (without "use client") and ' +
              "import it, or write it inline."
          : `\`${name}\` is a binding of the enclosing function. Read what ` +
              "you need from the predicate's argument (`currentParams`, " +
              "`nextUrl`, `context`, `actionResult`, ...).",
      );
    }
    const browserGlobal = free.globals.find((ref) =>
      BROWSER_GLOBALS.has(ref.node.name),
    );
    if (browserGlobal) {
      throw revalidateError(
        file,
        code,
        browserGlobal.node,
        `\`${browserGlobal.node.name}\` is a browser global. Put the input ` +
          "on the request (a cookie or a search param) and read it from the " +
          "predicate's argument, or refresh the loader with useRefreshLoaders.",
      );
    }

    for (const [local, valueUse] of free.imports) {
      if (valueUse && !used.get(local)) {
        await checkServerSafe(local, imports.get(local)!, deps, (detail) =>
          revalidateError(file, code, value, detail),
        );
      }
      used.set(local, (used.get(local) ?? false) || valueUse);
    }

    const source = code.slice(value.start, value.end);
    const key = keyOf(relativeFile, value);
    entries.set(key, source);
    s.overwrite(
      arg.start,
      arg.end,
      `{ ${HOISTED_REVALIDATE_KEY}: ${JSON.stringify(key)} }`,
    );
  }

  const importLines = await emitImports(used, imports, () => {});
  const module = [
    `import { registerClientUrlRevalidators as ${REGISTER} } from "@rangojs/router/server";`,
    ...importLines,
    `${REGISTER}({`,
    ...[...entries].map(
      ([key, source]) => `  ${JSON.stringify(key)}: ${source},`,
    ),
    `});`,
    "",
  ].join("\n");

  return {
    code: s.toString(),
    map: s.generateMap({ hires: true, source: file }),
    module,
    keys: [...entries.keys()],
  };
}

async function checkServerSafe(
  local: string,
  binding: ImportBinding,
  deps: HoistClientUrlsRevalidateDeps,
  fail: (detail: string) => Error,
): Promise<void> {
  if (
    binding.source === "client-only" ||
    (await deps.isClientModule?.(binding.source))
  ) {
    throw fail(
      `\`${local}\` is imported from "${binding.source}", a client-only ` +
        'module: on the server a "use client" module\'s exports are client ' +
        "references and cannot be called. Import the predicate's inputs " +
        'from a module without "use client".',
    );
  }
}

/** The file a `?rango-revalidate` id names, or null. */
export function parseHoistedRevalidateId(id: string): string | null {
  const q = id.indexOf("?");
  if (q === -1) return null;
  const params = new URLSearchParams(id.slice(q + 1));
  return params.has(CLIENT_URLS_REVALIDATE_QUERY) ? id.slice(0, q) : null;
}

/**
 * The plugins: a pre transform that hoists in every environment (markers in
 * the client and SSR copies, the server module recorded from the RSC
 * transform) and serves `?rango-revalidate`, and a post transform that
 * appends its import to the RSC client-reference proxy.
 *
 * `load` serves the module the RSC transform emitted, which hoisted the
 * pipeline code; the disk source is re-hoisted only when the transform has
 * not seen the current file (an edit the RSC environment has not
 * re-transformed yet). A file whose edit removed every predicate serves an
 * empty module to a proxy that still imports it.
 */
export function clientUrlsRevalidateHoistPlugin(): Plugin[] {
  const emitted = new Map<string, EmittedEntry<string>>();
  let root = process.cwd();
  return [
    {
      name: "@rangojs/router:client-urls-revalidate-hoist",
      enforce: "pre",

      configResolved(config) {
        root = config.root;
      },

      async load(id) {
        const hoistedFile = parseHoistedRevalidateId(id);
        if (hoistedFile === null) return;
        const module = await loadEmittedOrDisk(
          emitted,
          hoistedFile,
          async (disk) =>
            (await hoistClientUrlsRevalidates(disk, hoistedFile, { root }))
              ?.module,
        );
        return module ?? "export {};\n";
      },

      async transform(code, id) {
        if (id.includes("/node_modules/") || parseHoistedRevalidateId(id)) {
          return;
        }
        const file = normalizePath(id.split("?", 1)[0]!);
        if (!SOURCE_FILE_RE.test(file)) return;
        const rsc = this.environment?.name === "rsc";
        if (rsc) emitted.delete(file);
        const result = await hoistClientUrlsRevalidates(code, id, {
          root,
          isClientModule: rsc
            ? async (source) => {
                const target = await resolveSourceTarget(this, source, id, {
                  skipNodeModules: false,
                });
                if (target === null) return false;
                const text = await readSource(target);
                return text !== null && hasUseClientDirective(text);
              }
            : undefined,
        });
        if (!result) return;
        if (rsc) await recordEmitted(emitted, file, result.module);
        return { code: result.code, map: result.map };
      },
    },
    {
      name: "@rangojs/router:client-urls-revalidate-register",
      enforce: "post",
      transform(code, id) {
        if (this.environment?.name !== "rsc") return;
        if (parseHoistedRevalidateId(id)) return;
        const file = normalizePath(id.split("?", 1)[0]!);
        if (!emitted.has(file) || !code.includes("registerClientReference")) {
          return;
        }
        const s = new MagicString(code);
        s.append(
          `\nimport ${JSON.stringify(`${file}?${CLIENT_URLS_REVALIDATE_QUERY}`)};\n`,
        );
        return { code: s.toString(), map: s.generateMap({ hires: true }) };
      },
    },
  ];
}
