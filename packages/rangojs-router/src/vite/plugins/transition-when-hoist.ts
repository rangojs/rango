import type { Plugin } from "vite";
import { normalizePath, parseAst } from "vite";
import MagicString from "magic-string";
import { builtinModules } from "node:module";
import { readFile } from "node:fs/promises";
import { TransitionWhenError } from "../../transition-when-ref.js";
import {
  analyzeScopes,
  collectImports,
  type ImportBinding,
  type Node,
  type Scope,
} from "./hoist/scope.js";
import {
  collectFreeReferences,
  directivePrologueEnd,
  emitImports,
  findHelperCalls,
  findLexicalCapture,
  hasDirective,
  isFunctionLiteral,
  lineColumn,
  parseLang,
  propertyKeyIs,
  unwrapExpression,
  type LexicalCaptureMessages,
} from "./hoist/literal.js";

/**
 * Inline transition({ when }) in urls(): the build hoists the function
 * literal into a virtual "use client" module, so it reaches the browser as a
 * client reference like an exported predicate would.
 *
 *   transition({ when: (ctx) => ctx.to.params.tab !== "raw" })
 *
 * becomes, in the urls module,
 *
 *   import { __rango_when as __rango_when_0 } from "<file>?rango-when=0";
 *   transition({ when: __rango_when_0 })
 *
 * and `<file>?rango-when=0` (a query on the urls file itself, so relative
 * imports resolve as they did there and an edit invalidates it in every
 * environment's graph) is
 *
 *   "use client";
 *   <the module-level imports the literal references>
 *   export const __rango_when = (ctx) => ctx.to.params.tab !== "raw";
 *
 * Keyed on `transition({ when: <function literal> })` where the callee is the
 * router's transition: an import from "@rangojs/router" (renamed or through a
 * namespace), or the helper a router urls() callback receives (destructured,
 * renamed, or as `helpers.transition`). Any other function named
 * `transition` is left alone. There is no function-level "use client" (React
 * defines the directive per module). The literal may be an arrow, a function
 * expression or a `when() {}` method, under TS wrappers (`as`, `satisfies`,
 * `!`, `<T>`), which are dropped.
 *
 * A literal may not capture anything: a free reference to a module binding
 * that is not an import (JSX component names included), to an enclosing
 * function's binding, or an arrow's lexical `this`/`arguments`/`super`/
 * `new.target`, is a LOUD error naming it; so are `import()` and
 * `import.meta` other than `import.meta.env`, whose targets the build cannot
 * check. Referenced imports are re-emitted, so they must be client-safe: a
 * server-only one fails naming the import. An identifier value must be a
 * "use client" import; a local binding fails here, anything else in route
 * discovery. "use client" modules (clientUrls()) are left alone: their `when`
 * is already browser code. Vitest does not run the plugin, so in unit tests
 * the literal stays a plain function.
 */

const TRANSITION_WHEN_QUERY = "rango-when";
const EXPORT_NAME = "__rango_when";
const LOCAL_PREFIX = "__rango_when_";

/**
 * A `when` site: the `when` property of a router transition() config, and its
 * value with TS wrappers dropped (a function literal, an identifier, ...).
 */
interface WhenSite {
  readonly prop: Node;
  readonly value: Node;
  readonly scope: Scope;
}

const ROUTER_SOURCES: ReadonlySet<string> = new Set(["@rangojs/router"]);

function findWhenSites(
  program: Node,
  scopeOf: Map<Node, Scope>,
  moduleScope: Scope,
  imports: Map<string, ImportBinding>,
): WhenSite[] {
  const sites: WhenSite[] = [];
  for (const { call, scope } of findHelperCalls(
    program,
    scopeOf,
    moduleScope,
    imports,
    {
      sources: ROUTER_SOURCES,
      builder: "urls",
      helper: "transition",
      directImport: true,
    },
  )) {
    if (call.arguments[0]?.type !== "ObjectExpression") continue;
    for (const prop of call.arguments[0].properties) {
      if (propertyKeyIs(prop, "when")) {
        sites.push({ prop, value: unwrapExpression(prop.value), scope });
      }
    }
  }
  return sites;
}

/** Why a lexical-context use in a literal is a capture, by construct. */
const WHEN_CAPTURE_MESSAGES: LexicalCaptureMessages = {
  lexical: {
    this: "`this` in an arrow is the enclosing server function's `this`.",
    arguments:
      "`arguments` in an arrow is the enclosing server function's `arguments`.",
    super: "`super` refers to the enclosing server object.",
    "new.target":
      "`new.target` in an arrow is the enclosing server function's.",
  },
  captureHint:
    "Read what you need from `to.params`/`to.state`, or export the " +
    'predicate from a "use client" module.',
  loadsHint:
    "Import client-safe modules statically, or export the predicate from a " +
    '"use client" module.',
  importMetaWhy: "is the server module's.",
  importMetaMemberWhy:
    "is resolved against the server module; only `import.meta.env` is " +
    "available to an inline predicate.",
  dynamicImportWhy:
    "loads a module at run time, which the build cannot check is client-safe.",
};

const NODE_BUILTINS = new Set(builtinModules);

/** Specifiers that can never load in the browser. */
export function isServerOnlySpecifier(source: string): boolean {
  return (
    source === "server-only" ||
    source.startsWith("node:") ||
    source.startsWith("cloudflare:") ||
    NODE_BUILTINS.has(source)
  );
}

export interface HoistTransitionWhenDeps {
  /**
   * Whether an import the literal re-emits is server-only beyond its
   * specifier (the plugin resolves it and looks for `import "server-only"`).
   */
  isServerOnlyImport?(source: string): Promise<boolean> | boolean;
}

export interface HoistTransitionWhenResult {
  readonly code: string;
  readonly map: ReturnType<MagicString["generateMap"]>;
  /** Virtual module source per hoisted literal, by index. */
  readonly modules: readonly string[];
}

// Cheap pre-filter before a parse: every hoistable site needs an import from
// the router (transition itself, or the urls() that hands it out) and a
// `when` key in some form (`when:`, `"when":`, `when() {}`, `get when()`),
// possibly under an alias, so no tighter pattern holds. The AST walk is the
// authority.
const ROUTER_IMPORT_RE = /["']@rangojs\/router["']/;
const WHEN_RE = /\bwhen\b/;

function whenError(file: string, code: string, node: Node, detail: string) {
  return new TransitionWhenError(
    `[rango] transition({ when }) at ${file}:${lineColumn(code, node.start)}: ` +
      `\`when\` runs in the browser; ${detail}`,
  );
}

/**
 * Hoist every inline `transition({ when: <function literal> })` of a urls
 * module. Returns null when there is nothing to hoist. Throws a
 * TransitionWhenError for a capture, a server-only import or module-loading
 * expression, an accessor `when`, or a local identifier value.
 */
export async function hoistTransitionWhens(
  code: string,
  id: string,
  deps: HoistTransitionWhenDeps = {},
): Promise<HoistTransitionWhenResult | null> {
  if (!ROUTER_IMPORT_RE.test(code) || !WHEN_RE.test(code)) return null;
  const file = normalizePath(id.split("?", 1)[0]!);
  let program: Node;
  try {
    program = parseAst(code, { lang: parseLang(file) });
  } catch {
    return null;
  }
  if (hasDirective(program, "use client")) return null;

  const { moduleScope, references, scopeOf } = analyzeScopes(program);
  const imports = collectImports(program);
  const sites = findWhenSites(program, scopeOf, moduleScope, imports);
  if (sites.length === 0) return null;

  const s = new MagicString(code);
  const modules: string[] = [];
  const header: string[] = [];

  for (const site of sites) {
    const { prop, value } = site;
    if (prop.kind === "get" || prop.kind === "set") {
      throw whenError(
        file,
        code,
        prop,
        `\`${prop.kind} when()\` is an accessor; \`when\` must be the ` +
          "predicate itself: `when: (ctx) => ...` or `when(ctx) { ... }`.",
      );
    }
    if (value.type === "Identifier") {
      const decl = site.scope.lookup(value.name);
      if (decl && !(decl === moduleScope && imports.has(value.name))) {
        throw whenError(
          file,
          code,
          value,
          `\`${value.name}\` is a server-module binding. Export the predicate ` +
            'from a "use client" module and import it, or write it inline.',
        );
      }
      continue;
    }
    if (!isFunctionLiteral(value)) continue;

    const lexical = findLexicalCapture(
      value,
      references,
      code,
      WHEN_CAPTURE_MESSAGES,
    );
    if (lexical) throw whenError(file, code, lexical.node, lexical.detail);

    const free = collectFreeReferences(value, references, moduleScope, imports);
    const binding = free.bindings[0];
    if (binding) {
      throw whenError(
        file,
        code,
        binding.node,
        `\`${binding.node.name}\` is a server-module binding. Read it from ` +
          "`to.params`/`to.state`, or export the predicate from a " +
          '"use client" module.',
      );
    }

    const importLines = await emitImports(
      free.imports,
      imports,
      async (local, imported) => {
        if (
          isServerOnlySpecifier(imported.source) ||
          (await deps.isServerOnlyImport?.(imported.source))
        ) {
          throw whenError(
            file,
            code,
            value,
            `\`${local}\` is imported from "${imported.source}", a server-only ` +
              "module. Import only client-safe modules into an inline " +
              'predicate, or export it from a "use client" module.',
          );
        }
      },
    );

    // A method's FunctionExpression spans from its type parameters or
    // parameters; the async/generator markers sit on the property.
    const source = prop.method
      ? `${value.async ? "async " : ""}function${value.generator ? "*" : ""} ` +
        code.slice(value.start, value.end)
      : code.slice(value.start, value.end);
    const index = modules.length;
    modules.push(
      [
        `"use client";`,
        ...importLines,
        `export const ${EXPORT_NAME} = ${source};`,
        "",
      ].join("\n"),
    );
    const local = `${LOCAL_PREFIX}${index}`;
    // The whole property: drops a method's markers and TS wrappers with it.
    s.overwrite(
      prop.start,
      prop.end,
      `${code.slice(prop.key.start, prop.key.end)}: ${local}`,
    );
    header.push(
      `import { ${EXPORT_NAME} as ${local} } from ${JSON.stringify(
        `${file}?${TRANSITION_WHEN_QUERY}=${index}`,
      )};`,
    );
  }

  if (modules.length === 0) return null;

  // After the directive prologue, so a "use server"/"use strict" stays first.
  const insertAt = directivePrologueEnd(program);
  s.appendLeft(insertAt, `${insertAt ? "\n" : ""}${header.join("\n")}\n`);

  return {
    code: s.toString(),
    map: s.generateMap({ hires: true, source: file }),
    modules,
  };
}
/** The hoisted module index a `?rango-when=N` id names, or null. */
export function parseHoistedWhenId(
  id: string,
): { file: string; index: number } | null {
  const q = id.indexOf("?");
  if (q === -1) return null;
  const params = new URLSearchParams(id.slice(q + 1));
  const raw = params.get(TRANSITION_WHEN_QUERY);
  if (raw === null || !/^\d+$/.test(raw)) return null;
  return { file: id.slice(0, q), index: Number(raw) };
}

const SERVER_ONLY_IMPORT_RE = /\bimport\s+["']server-only["']/;

async function readSource(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf-8");
  } catch {
    return null;
  }
}

/** What the RSC transform emitted for a urls file, and the disk source it saw. */
interface EmittedWhens {
  readonly disk: string | null;
  readonly modules: readonly string[];
}

/**
 * The plugin: hoists in the RSC environment (where urls() modules are
 * evaluated) and serves the `?rango-when=N` modules in every environment
 * (RSC, SSR and client all load them).
 *
 * `load` serves the modules the transform emitted, not a re-hoist of the file
 * on disk: the transform hoists the pipeline code, which an earlier plugin
 * may have changed, so re-hoisting the disk source can number the literals
 * differently and serve the wrong one for index N. The disk source is the
 * fallback only when the transform has not seen the current file: an
 * environment loading before the RSC transform ran (the order environments
 * ask in is not fixed), or an edit the RSC environment has not re-transformed
 * yet (serving the last transform would then be stale). The map is per
 * plugin instance, so every environment of one dev server or build shares it.
 */
export function transitionWhenHoistPlugin(): Plugin {
  const emitted = new Map<string, EmittedWhens>();
  return {
    name: "@rangojs/router:transition-when-hoist",
    enforce: "pre",

    async load(id) {
      const hoisted = parseHoistedWhenId(id);
      if (!hoisted) return;
      const file = normalizePath(hoisted.file);
      const disk = await readSource(hoisted.file);
      const entry = emitted.get(file);
      const modules =
        entry && (disk === null || entry.disk === disk)
          ? entry.modules
          : disk === null
            ? undefined
            : (await hoistTransitionWhens(disk, hoisted.file))?.modules;
      const module = modules?.[hoisted.index];
      if (module === undefined) {
        throw new TransitionWhenError(
          `[rango] ${hoisted.file} has no inline transition({ when }) #${hoisted.index}.`,
        );
      }
      return module;
    },

    async transform(code, id) {
      if (this.environment?.name !== "rsc") return;
      if (id.includes("/node_modules/") || parseHoistedWhenId(id)) return;
      const file = normalizePath(id.split("?", 1)[0]!);
      if (!/\.[cm]?[jt]sx?$/.test(file)) return;
      emitted.delete(file);
      const result = await hoistTransitionWhens(code, id, {
        isServerOnlyImport: async (source) => {
          const resolved = await this.resolve(source, id);
          if (!resolved || resolved.external) return false;
          const target = resolved.id.split("?", 1)[0]!;
          if (target.includes("/node_modules/") || target.startsWith("\0")) {
            return false;
          }
          const text = await readSource(target);
          return text !== null && SERVER_ONLY_IMPORT_RE.test(text);
        },
      });
      if (!result) return;
      emitted.set(file, {
        disk: await readSource(file),
        modules: result.modules,
      });
      return { code: result.code, map: result.map };
    },
  };
}
