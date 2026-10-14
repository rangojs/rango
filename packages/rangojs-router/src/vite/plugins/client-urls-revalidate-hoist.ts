import type { EnvironmentModuleNode, Plugin } from "vite";
import { normalizePath, parseAst } from "vite";
import MagicString from "magic-string";
import { createHash } from "node:crypto";
import { relative } from "node:path";
import { hasDirective } from "@vitejs/plugin-rsc/transforms";
import { HOISTED_REVALIDATE_KEY } from "../../client-urls/hoisted-revalidate.js";
import {
  CLIENT_IMPORT_RE,
  CLIENT_URLS_REVALIDATE_QUERY,
  componentUseSignature,
  hoistedRevalidateId,
} from "../discovery/client-urls-projection.js";
import type { ClientUrlRevalidateIndex } from "../discovery/state.js";
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
  type SourceResolver,
} from "./hoist/source.js";

/**
 * clientUrls() loader `revalidate()` runs on the server, with the arguments a
 * urls() loader's predicate gets. The predicate is declared in client code (a
 * "use client" group, or a component's `.use` in any module the group
 * imports), so the build moves it into a server module (the reverse of
 * transition-when-hoist.ts):
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
 * `import "<file>?rango-revalidate"` to the proxy of every group (a
 * "use client" module calling clientUrls()). The proxy has none of the
 * group's imports, and a component's `.use` may sit in any module the group
 * reaches. Route discovery serializes the group's SSR copy, so its projection
 * carries every key the group reads, and the transform records each key's
 * file in every environment (ClientUrlRevalidateIndex): discovery assigns
 * the group the files of its keys as it installs the projection
 * (discovery/client-urls-projection.ts), and the group's `?rango-revalidate`
 * module imports theirs. Their registrations load with the group and nothing
 * else of those files does, so no client code loads on the server and a lazy
 * include stays lazy, wherever the file sits: behind barrels or in another
 * workspace package. Materialization
 * (client-urls/server-projection.ts) attaches the registered predicates to
 * the loader stubs; a key nothing registered fails loudly there.
 *
 * A key hashes the project-relative file and the predicate's syntax tree
 * (formatting, comments and TypeScript excluded, so a re-printing transform
 * in one environment keeps it): two environments that saw a different
 * predicate fail loudly at materialization instead of pairing a loader with
 * the wrong one. A module several groups import registers once.
 *
 * Keyed on calls of the `revalidate` helper from "@rangojs/router/client":
 * imported directly (a component's `.use`), or handed out by a clientUrls()
 * builder callback (destructured, renamed, or as `helpers.revalidate`). The
 * argument may reference imports and globals only: a binding of the module
 * or of an enclosing function, `this`/`arguments`/`super`/`new.target`,
 * `import()`, `import.meta` other than `import.meta.env`, a browser-only
 * global, an `async` or generator function, or an import of a "use client"
 * module is a LOUD error naming file:line. Imports stay in the client module
 * too (they are not pruned). Vitest does not run the plugin, so in unit
 * tests the predicate stays a plain function.
 *
 * `revalidate(true)` / `revalidate(false)` LITERALS stay in place: the
 * projection carries the boolean and materialization turns it into the
 * constant predicate. Any other argument is hoisted whatever it evaluates
 * to, because an imported boolean and an imported predicate are both
 * identifiers to the build: the server evaluates the expression, and a
 * boolean result means the same constant answer (`revalidate(FLAG)` with an
 * imported `FLAG`). Materialization rejects a value that is neither.
 */

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

// Cheap pre-filters: a site imports the router's client entry and names a
// `revalidate` helper; a group also names clientUrls. The AST walk is the
// authority.
const CLIENT_URLS_RE = /\bclientUrls\b/;
const REVALIDATE_RE = /\brevalidate\b/;
const CANDIDATE_RE = /\b(?:clientUrls|revalidate)\b/;

function mayHoist(code: string): boolean {
  return CLIENT_IMPORT_RE.test(code) && REVALIDATE_RE.test(code);
}

/** A clientUrls() group: its RSC proxy imports the registrations. */
function isGroupModule(code: string): boolean {
  return (
    code.includes("use client") &&
    CLIENT_URLS_RE.test(code) &&
    CLIENT_IMPORT_RE.test(code) &&
    hasUseClientDirective(code)
  );
}

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
      // A tag sees the raw text: String.raw`\x41` is not String.raw`A`.
      if (entry.type === "TemplateElement") {
        out.push(JSON.stringify(entry.value.raw));
      }
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
 * Hoist every clientUrls() `revalidate()` predicate of a module. Returns null
 * when there is none (boolean literals stay in place). Throws, naming
 * file:line, for a predicate that is not pure.
 */
export async function hoistClientUrlsRevalidates(
  code: string,
  id: string,
  deps: HoistClientUrlsRevalidateDeps,
): Promise<HoistClientUrlsRevalidateResult | null> {
  if (!mayHoist(code)) return null;
  const file = normalizePath(id.split("?", 1)[0]!);
  const program = parseProgram(code, file);
  if (!program) return null;
  const { moduleScope, references, scopeOf } = analyzeScopes(program);
  const imports = collectImports(program);
  const calls = findHelperCalls(program, scopeOf, moduleScope, imports, {
    sources: CLIENT_SOURCES,
    builder: "clientUrls",
    helper: "revalidate",
    directImport: true,
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
        "`revalidate()` takes exactly one predicate or boolean.",
      );
    }
    const value = unwrapExpression(arg);
    // The same constant in every environment: nothing to move.
    if (value.type === "Literal" && typeof value.value === "boolean") continue;
    if (NOT_A_FUNCTION.has(value.type)) {
      throw revalidateError(
        file,
        code,
        value,
        "`revalidate()` expects a predicate function or a boolean.",
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
          ? `\`${name}\` is declared in this ` +
              (hasDirective(program.body, "use client")
                ? '"use client" module'
                : "module") +
              ". Move the predicate to its own module (without " +
              '"use client") and import it, or write it inline.'
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

    const unchecked = [...free.imports].filter(
      ([local, valueUse]) => valueUse && !used.get(local),
    );
    const clientOnly = await Promise.all(
      unchecked.map(([local]) => isClientOnly(imports.get(local)!, deps)),
    );
    const offender = unchecked.find((_, i) => clientOnly[i]);
    if (offender) {
      const [local] = offender;
      throw revalidateError(
        file,
        code,
        value,
        `\`${local}\` is imported from "${imports.get(local)!.source}", a ` +
          'client-only module: on the server a "use client" module\'s ' +
          "exports are client references and cannot be called. Import the " +
          'predicate\'s inputs from a module without "use client".',
      );
    }
    for (const [local, valueUse] of free.imports) {
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

  if (entries.size === 0) return null;

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

async function isClientOnly(
  binding: ImportBinding,
  deps: HoistClientUrlsRevalidateDeps,
): Promise<boolean> {
  return (
    binding.source === "client-only" ||
    Boolean(await deps.isClientModule?.(binding.source))
  );
}

function parseProgram(code: string, file: string): Node | null {
  try {
    return parseAst(code, { lang: parseLang(file) });
  } catch {
    return null;
  }
}

/** The file a `?rango-revalidate` id names, or null. */
export function parseHoistedRevalidateId(id: string): string | null {
  const q = id.indexOf("?");
  if (q === -1) return null;
  const params = new URLSearchParams(id.slice(q + 1));
  return params.has(CLIENT_URLS_REVALIDATE_QUERY) ? id.slice(0, q) : null;
}

// The hook filters below are conservative screens (a superset of what the
// handlers accept): the handlers keep their exact checks.
const HOISTED_ID_RE = new RegExp(
  `[?&]${CLIENT_URLS_REVALIDATE_QUERY}(?:[=&]|$)`,
);
const SOURCE_ID_RE = /\.[cm]?[jt]sx?(?:\?|$)/;
const NODE_MODULES_RE = /\/node_modules\//;
const USE_ASSIGNMENT_RE = /\.use\s*=/;

/**
 * The plugins: a pre transform that hoists in every environment (markers in
 * the client and SSR copies, each key's file in `index`, the server module
 * recorded from the RSC transform, the groups noted) and serves
 * `?rango-revalidate`, a post transform that appends its import to the RSC
 * client-reference proxy of each group, and in dev the client's `.use`
 * update propagation. Pass one `index` to every instance of one rango():
 * discovery's temp server records keys the dev server or build reads.
 *
 * `load` serves the registrations the RSC transform emitted, which hoisted
 * the pipeline code; the disk source is re-hoisted when the transform has not
 * seen the current file (loadEmittedOrDisk), which is always the case for a
 * component module: the RSC environment never transforms a module only a
 * group imports. A group's module also imports the registrations of the
 * files discovery assigned it. A file with neither serves an empty module.
 *
 * A component module that exports only components is a Fast Refresh
 * boundary, so a `.use` edit would leave the browser's group records stale
 * (the group never re-evaluates). In dev, an update that changes a module's
 * componentUseSignature also updates its importers, as a group edit does;
 * any other edit keeps Fast Refresh.
 *
 * The transform's code filter skips a module that names neither clientUrls
 * nor revalidate, so a file that stops doing so would keep its `emitted`
 * entry: watchChange drops it, its group mark, and the cached "use client"
 * answer for an edited dependency (isClientModule memoizes per resolved
 * file; buildStart resets it).
 */
export function clientUrlsRevalidateHoistPlugin(
  index: ClientUrlRevalidateIndex,
): Plugin[] {
  const emitted = new Map<string, EmittedEntry<string>>();
  const groups = new Set<string>();
  const clientModules = new Map<string, Promise<boolean>>();
  const useSignatures = new Map<string, string>();
  let root = process.cwd();

  const isClientFile = (file: string): Promise<boolean> => {
    let known = clientModules.get(file);
    if (!known) {
      known = readSource(file).then(
        (text) =>
          text !== null &&
          text.includes("use client") &&
          hasUseClientDirective(text),
      );
      clientModules.set(file, known);
    }
    return known;
  };
  const clientModuleCheck =
    (ctx: SourceResolver, importer: string) =>
    async (source: string): Promise<boolean> => {
      const target = await resolveSourceTarget(ctx, source, importer, {
        skipNodeModules: false,
      });
      return target !== null && (await isClientFile(target));
    };

  return [
    {
      name: "@rangojs/router:client-urls-revalidate-hoist",
      enforce: "pre",

      configResolved(config) {
        root = normalizePath(config.root);
      },

      buildStart() {
        clientModules.clear();
      },

      watchChange(id) {
        const file = normalizePath(id);
        clientModules.delete(file);
        emitted.delete(file);
        groups.delete(file);
      },

      load: {
        filter: { id: HOISTED_ID_RE },
        async handler(id) {
          const hoistedFile = parseHoistedRevalidateId(id);
          if (hoistedFile === null) return;
          const file = normalizePath(hoistedFile);
          const registrations = await loadEmittedOrDisk(
            emitted,
            file,
            await readSource(file),
            async (source) =>
              (
                await hoistClientUrlsRevalidates(source, file, {
                  root,
                  isClientModule: clientModuleCheck(this, file),
                })
              )?.module,
          );
          const assigned = index.filesByGroup.get(file) ?? [];
          const code =
            registrations === undefined && assigned.length === 0
              ? "export {};\n"
              : [
                  registrations ?? "",
                  ...assigned.map(
                    (target) =>
                      `import ${JSON.stringify(hoistedRevalidateId(target))};\n`,
                  ),
                ].join("");
          // Reached only through bare imports, and the id names an app file,
          // so the app's package.json `"sideEffects": false` would let the
          // build drop the registrations (#1149). load outranks that field.
          return { code, moduleSideEffects: "no-treeshake" };
        },
      },

      transform: {
        filter: {
          id: {
            include: SOURCE_ID_RE,
            exclude: [NODE_MODULES_RE, HOISTED_ID_RE],
          },
          code: CANDIDATE_RE,
        },
        async handler(code, id) {
          if (id.includes("/node_modules/") || parseHoistedRevalidateId(id)) {
            return;
          }
          const file = normalizePath(id.split("?", 1)[0]!);
          if (!SOURCE_FILE_RE.test(file)) return;
          const rsc = this.environment?.name === "rsc";
          if (rsc) {
            emitted.delete(file);
            if (isGroupModule(code)) groups.add(file);
            else groups.delete(file);
          }
          const result = await hoistClientUrlsRevalidates(code, id, {
            root,
            isClientModule: rsc ? clientModuleCheck(this, id) : undefined,
          });
          if (!result) return;
          for (const key of result.keys) index.fileByKey.set(key, file);
          if (rsc) await recordEmitted(emitted, file, result.module);
          return { code: result.code, map: result.map };
        },
      },
    },
    {
      name: "@rangojs/router:client-urls-revalidate-register",
      enforce: "post",
      applyToEnvironment: (env) => env.name === "rsc",

      transform: {
        filter: { code: "registerClientReference" },
        handler(code, id) {
          if (parseHoistedRevalidateId(id)) return;
          const file = normalizePath(id.split("?", 1)[0]!);
          if (!groups.has(file)) return;
          const s = new MagicString(code);
          s.append(`\nimport ${JSON.stringify(hoistedRevalidateId(file))};\n`);
          return { code: s.toString(), map: s.generateMap({ hires: true }) };
        },
      },
    },
    {
      name: "@rangojs/router:client-urls-component-use-hmr",
      apply: "serve",
      applyToEnvironment: (env) => env.name === "client",

      transform: {
        filter: {
          id: { include: SOURCE_ID_RE, exclude: [NODE_MODULES_RE] },
          code: USE_ASSIGNMENT_RE,
        },
        async handler(_code, id) {
          // The disk source, as hotUpdate reads it: an earlier transform may
          // re-print the module.
          const file = normalizePath(id.split("?", 1)[0]!);
          const disk = await readSource(file);
          const signature = disk && componentUseSignature(disk, file);
          if (signature) useSignatures.set(file, signature);
        },
      },

      async hotUpdate({ file, modules, read }) {
        if (modules.length === 0 || !SOURCE_FILE_RE.test(file)) return;
        const next = componentUseSignature(await read(), file);
        if (next === useSignatures.get(file)) return;
        if (next === undefined) useSignatures.delete(file);
        else useSignatures.set(file, next);
        const updated = new Set<EnvironmentModuleNode>(modules);
        for (const mod of modules) {
          for (const importer of mod.importers) updated.add(importer);
        }
        return [...updated];
      },
    },
  ];
}
