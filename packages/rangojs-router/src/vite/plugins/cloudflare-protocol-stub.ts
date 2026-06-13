import type { Plugin } from "vite";

const VIRTUAL_PREFIX = "virtual:rango-cloudflare-stub-";
const NULL_PREFIX = "\0" + VIRTUAL_PREFIX;
const CF_PREFIX = "cloudflare:";

/**
 * `globalThis` key the `cloudflare:workers` stub reads to populate its
 * `env` export. Router discovery sets this to the resolved `buildEnv`
 * proxy (from `wrangler.getPlatformProxy()` when `buildEnv: "auto"` is
 * configured, or a user-supplied object otherwise) before importing the
 * worker entry, and clears it after discovery disposes the proxy. When
 * unset, the stub's `env` falls back to `{}`.
 *
 * Using `globalThis` is the only cross-module bridge that works here:
 * the stub's `load` hook returns source text, not a live closure, but
 * the stub module is evaluated in the same Node process as the
 * discovery plugin — so reading a global at module-evaluation time
 * reaches whatever the plugin assigned there. A symbol key would be
 * cleaner in-process but awkward to name from the stub source.
 *
 * @internal
 */
export const BUILD_ENV_GLOBAL_KEY = "__rango_build_env__";

const SOURCE_EXT_RE = /\.[mc]?[jt]sx?$/;

const IMPORT_NODE_TYPES = new Set([
  "ImportDeclaration",
  "ImportExpression",
  "ExportNamedDeclaration",
  "ExportAllDeclaration",
]);

const STUBS: Record<string, string> = {
  "cloudflare:workers": `
export class DurableObject { constructor(_ctx, _env) {} }
export class WorkerEntrypoint { constructor(_ctx, _env) {} }
export class WorkflowEntrypoint { constructor(_ctx, _env) {} }
export class RpcTarget {}
export const env = globalThis[${JSON.stringify(BUILD_ENV_GLOBAL_KEY)}] ?? {};
export default {};
`,
  "cloudflare:email": `
export class EmailMessage { constructor(_from, _to, _raw) {} }
export default {};
`,
  "cloudflare:sockets": `
export function connect() { return {}; }
export default {};
`,
  "cloudflare:workflows": `
export class NonRetryableError extends Error {
  constructor(message, name) { super(message); this.name = name ?? "NonRetryableError"; }
}
export default {};
`,
};

const FALLBACK_STUB = `export default {};\n`;

interface AstNode {
  type: string;
  start?: number;
  end?: number;
  source?: AstNode | null;
  value?: unknown;
  [key: string]: unknown;
}

/**
 * Stubs `cloudflare:*` imports for the discovery-time Node Vite server.
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
 * The transform runs on user source AND on compiled node_modules
 * output: real-world CF packages (e.g. the Cloudflare Agents SDK)
 * ship compiled JS that contains `import ... from "cloudflare:email"`
 * and similar, so excluding node_modules would leave those imports
 * unrewritten. Cost is small because the early exit (`code.includes`)
 * skips files with no cloudflare: mention.
 *
 * The plugin intentionally runs at Vite's default ordering (no
 * `enforce: "pre"`) so TS/JSX has already been compiled to plain JS
 * by the time `this.parse` runs — acorn doesn't understand
 * non-standard syntax.
 *
 * `cloudflare:workers`, `cloudflare:email`, `cloudflare:sockets`, and
 * `cloudflare:workflows` each get curated stubs with the well-known
 * symbols that appear in top-level `extends` positions. Any other
 * `cloudflare:*` specifier falls back to an empty default export —
 * discovery never executes the handlers, so an empty module is safe
 * for anything the graph pulls in transitively.
 *
 * Only registered in the discovery temp server, not the user's runtime
 * config.
 * @internal
 */
export function createCloudflareProtocolStubPlugin(): Plugin {
  return {
    name: "@rangojs/router:cloudflare-protocol-stub",
    transform(code, id) {
      const cleanId = id.split("?")[0] ?? id;
      if (!SOURCE_EXT_RE.test(cleanId)) return null;
      if (!code.includes(CF_PREFIX)) return null;

      let ast: AstNode;
      try {
        ast = this.parse(code, { lang: "tsx" }) as unknown as AstNode;
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
      const specifier = CF_PREFIX + submodule;
      return STUBS[specifier] ?? FALLBACK_STUB;
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
