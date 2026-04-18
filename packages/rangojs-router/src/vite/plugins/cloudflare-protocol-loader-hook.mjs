// Node ESM loader hook that resolves `cloudflare:*` imports to the same
// stub ESM the Vite transform produces for rewritten specifiers.
//
// Why both? The Vite transform (cloudflare-protocol-stub.ts) catches
// imports in modules that flow through Vite's plugin pipeline — covers
// user source and any node_modules package Vite fetches and transforms.
// But Vite/Rollup externalize certain packages (e.g. `partyserver`,
// which has `import { DurableObject, env } from "cloudflare:workers"`
// at its top level, and similar "workerd-native" libraries). Externalized
// modules bypass the transform: Rollup hands their resolution to Node's
// native ESM loader, which rejects URL-scheme specifiers. This loader
// hook registers via `module.register()` from `createTempRscServer` and
// intercepts `cloudflare:*` at Node's resolve layer — before the default
// loader throws ERR_UNSUPPORTED_ESM_URL_SCHEME.
//
// Lifecycle: the hook runs in a dedicated worker thread (Node ESM loader
// architecture) with its own globalThis. It cannot see the main thread's
// `__rango_build_env__` bridge, so the `env` export here is always `{}`.
// That's fine in practice — externalized libraries don't typically touch
// `env` at module top level; they read it at request time in workerd
// where the real module exists. Build-time prerender handlers in user
// source DO read `env`, but they flow through the Vite transform (which
// does bridge `env` from `getPlatformProxy()`), not through this loader.
//
// Keep STUBS in sync with cloudflare-protocol-stub.ts — both paths need
// to hand out the same base classes.

const CF_PREFIX = "cloudflare:";

const STUBS = {
  "cloudflare:workers": `
export class DurableObject { constructor(_ctx, _env) {} }
export class WorkerEntrypoint { constructor(_ctx, _env) {} }
export class WorkflowEntrypoint { constructor(_ctx, _env) {} }
export class RpcTarget {}
export const env = {};
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

// Policy: unknown `cloudflare:*` specifiers resolve permissively to an
// empty default export rather than throwing. Same reasoning as
// cloudflare-protocol-stub.ts's FALLBACK_STUB — we prioritize
// dependency-graph resilience over strict validation, because third-party
// packages can pull `cloudflare:*` modules we haven't curated.
const FALLBACK_STUB = `export default {};\n`;

function dataUrlFor(specifier) {
  const body = STUBS[specifier] ?? FALLBACK_STUB;
  return "data:text/javascript;base64," + Buffer.from(body).toString("base64");
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(CF_PREFIX)) {
    return {
      shortCircuit: true,
      url: dataUrlFor(specifier),
      format: "module",
    };
  }
  return nextResolve(specifier, context);
}
