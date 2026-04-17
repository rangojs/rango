// Node ESM loader hook that resolves `cloudflare:*` imports during router
// discovery to a data: URL carrying a no-op stub. Registered via
// `module.register()` from `createTempRscServer` to cover paths where user
// modules are imported outside Vite's plugin pipeline — e.g. when a Node
// loader like tsx is active, or when @vitejs/plugin-rsc's module runner
// delegates to Node's native ESM loader for certain specifiers.
//
// Runs in a separate worker thread. Can't share state with the host — only
// exports documented loader hook functions. Data URLs are one of the URL
// schemes Node's default loader accepts natively, so returning one from
// `resolve` completes the chain without needing a matching `load` hook.
//
// Keep the stub bodies in sync with `STUBS` in cloudflare-protocol-stub.ts —
// both paths (Vite transform and Node loader) need to hand out the same
// classes. Unknown `cloudflare:*` modules fall back to an empty default
// export so third-party packages (e.g. the Cloudflare Agents SDK, which
// ships compiled JS under node_modules that imports `cloudflare:email`)
// don't blow up discovery for symbols their graph pulls in but never
// actually extends at module top level.

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
