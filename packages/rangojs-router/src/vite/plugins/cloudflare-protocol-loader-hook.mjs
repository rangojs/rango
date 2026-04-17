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
// Keep the stub body in sync with `CLOUDFLARE_WORKERS_STUB` in
// cloudflare-protocol-stub.ts — both paths (Vite transform and Node
// loader) need to hand out the same classes.

const CF_PREFIX = "cloudflare:";

const CF_WORKERS_STUB = `
export class DurableObject { constructor(_ctx, _env) {} }
export class WorkerEntrypoint { constructor(_ctx, _env) {} }
export class WorkflowEntrypoint { constructor(_ctx, _env) {} }
export class RpcTarget {}
export const env = {};
export default {};
`;

const CF_WORKERS_DATA_URL =
  "data:text/javascript;base64," +
  Buffer.from(CF_WORKERS_STUB).toString("base64");

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return {
      shortCircuit: true,
      url: CF_WORKERS_DATA_URL,
      format: "module",
    };
  }
  if (specifier.startsWith(CF_PREFIX)) {
    throw new Error(
      `[rsc-router] Unsupported \`${specifier}\` import encountered during router discovery. ` +
        `Only \`cloudflare:workers\` is stubbed today. ` +
        `Add a stub for \`${specifier}\` in packages/rangojs-router/src/vite/plugins/cloudflare-protocol-loader-hook.mjs ` +
        `(and mirror the change in cloudflare-protocol-stub.ts), or move the import out of the module graph that reaches the worker entry.`,
    );
  }
  return nextResolve(specifier, context);
}
