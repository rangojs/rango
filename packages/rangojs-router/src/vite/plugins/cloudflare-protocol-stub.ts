import type { Plugin } from "vite";

const VIRTUAL_PREFIX = "virtual:rango-cloudflare-stub-";
const NULL_PREFIX = "\0" + VIRTUAL_PREFIX;
const CF_PREFIX = "cloudflare:";

const SOURCE_EXT_RE = /\.[mc]?[jt]sx?$/;

const IMPORT_NODE_TYPES = new Set([
  "ImportDeclaration",
  "ImportExpression",
  "ExportNamedDeclaration",
  "ExportAllDeclaration",
]);

interface AstNode {
  type: string;
  start?: number;
  end?: number;
  source?: AstNode | null;
  value?: unknown;
  [key: string]: unknown;
}

/**
 * Stubs `cloudflare:workers` for the discovery-time Node Vite server.
 *
 * Discovery only evaluates user module top-level code — it never invokes
 * DurableObject / WorkerEntrypoint / Workflow handlers — so empty base
 * classes are enough for `class X extends DurableObject {}` declarations
 * to load in Node, where `cloudflare:*` is otherwise unresolvable.
 *
 * Interception point: a transform hook parses source with Rollup's
 * plugin-context parser (`this.parse`) and rewrites only real import
 * specifier spans (`import ... from "cloudflare:xxx"`,
 * `import("cloudflare:xxx")`, `export ... from "cloudflare:xxx"`) to a
 * plain virtual module name (`virtual:rango-cloudflare-stub-xxx`).
 * This must be done in transform because Vite's module runner routes
 * URL-scheme specifiers straight to Node's native ESM loader without
 * consulting plugin `resolveId` hooks. Using the AST (instead of a
 * text regex or a permissive lexer) guarantees that strings,
 * comments, and template literals that merely contain import-like
 * text are never mutated — the walker only looks at the four import
 * node types.
 *
 * The plugin intentionally runs at Vite's default ordering (no
 * `enforce: "pre"`) so TS/JSX has already been compiled to plain JS
 * by the time `this.parse` runs — acorn doesn't understand
 * non-standard syntax.
 *
 * Only `cloudflare:workers` is stubbed — the one that appears in
 * top-level `extends` positions in practice. Any other `cloudflare:*`
 * specifier throws a descriptive error at load time, which is strictly
 * more informative than silently returning an empty default (which
 * would still throw `undefined is not a constructor` at class-extend
 * time).
 *
 * Only registered in the discovery temp server, not the user's runtime
 * config.
 * @internal
 */
export function createCloudflareProtocolStubPlugin(): Plugin {
  return {
    name: "@rangojs/router:cloudflare-protocol-stub",
    transform(code, id) {
      if (id.includes("/node_modules/")) return null;
      const cleanId = id.split("?")[0] ?? id;
      if (!SOURCE_EXT_RE.test(cleanId)) return null;
      if (!code.includes(CF_PREFIX)) return null;

      let ast: AstNode;
      try {
        ast = this.parse(code) as unknown as AstNode;
      } catch {
        // Malformed source — let a downstream plugin surface the parse error.
        return null;
      }

      const hits: Array<{ start: number; end: number; value: string }> = [];
      walk(ast, (node) => {
        if (!IMPORT_NODE_TYPES.has(node.type)) return;
        const source = node.source;
        if (!source || source.type !== "Literal") return;
        if (typeof source.value !== "string") return;
        if (!source.value.startsWith(CF_PREFIX)) return;
        if (typeof source.start !== "number" || typeof source.end !== "number")
          return;
        hits.push({
          start: source.start,
          end: source.end,
          value: source.value,
        });
      });

      if (hits.length === 0) return null;

      // Rewrite from last to first so earlier offsets stay valid. `start`/
      // `end` span the full literal including quotes, so we re-emit the
      // same quote character around the new specifier.
      hits.sort((a, b) => b.start - a.start);
      let out = code;
      for (const hit of hits) {
        const submodule = hit.value.slice(CF_PREFIX.length);
        const quote = code[hit.start] === "'" ? "'" : '"';
        out =
          out.slice(0, hit.start) +
          quote +
          VIRTUAL_PREFIX +
          submodule +
          quote +
          out.slice(hit.end);
      }
      return { code: out, map: null };
    },
    resolveId(id) {
      if (id.startsWith(VIRTUAL_PREFIX)) {
        return "\0" + id;
      }
      return null;
    },
    load(id) {
      if (!id.startsWith(NULL_PREFIX)) return null;
      const submodule = id.slice(NULL_PREFIX.length);
      if (submodule === "workers") {
        return CLOUDFLARE_WORKERS_STUB;
      }
      throw new Error(
        `[rsc-router] Unsupported \`cloudflare:${submodule}\` import encountered during router discovery. ` +
          `Only \`cloudflare:workers\` is stubbed today. ` +
          `Add a stub for \`cloudflare:${submodule}\` in packages/rangojs-router/src/vite/plugins/cloudflare-protocol-stub.ts, ` +
          `or move the import out of the module graph that reaches the worker entry.`,
      );
    },
  };
}

function walk(node: unknown, visit: (n: AstNode) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const n = node as AstNode;
  if (typeof n.type !== "string") return;
  visit(n);
  for (const key in n) {
    if (key === "loc" || key === "start" || key === "end" || key === "range") {
      continue;
    }
    walk(n[key], visit);
  }
}

const CLOUDFLARE_WORKERS_STUB = `
export class DurableObject { constructor(_ctx, _env) {} }
export class WorkerEntrypoint { constructor(_ctx, _env) {} }
export class WorkflowEntrypoint { constructor(_ctx, _env) {} }
export class RpcTarget {}
export const env = {};
export default {};
`;
