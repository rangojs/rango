import type { Plugin } from "vite";

const STUB_PREFIX = "\0cloudflare-stub:";

/**
 * Stubs `cloudflare:workers` for the discovery-time Node Vite server.
 *
 * Discovery only evaluates user module top-level code — it never invokes
 * DurableObject / WorkerEntrypoint / Workflow handlers — so empty base
 * classes are enough for `class X extends DurableObject {}` style
 * declarations to load in Node, where `cloudflare:*` is otherwise
 * unresolvable.
 *
 * Only `cloudflare:workers` is handled because that's the one that
 * appears in top-level `extends` positions in practice. Any other
 * `cloudflare:*` specifier fails with a descriptive error pointing at
 * this file — that's strictly more informative than silently returning
 * an empty default (which would still throw `undefined is not a
 * constructor` the moment a named import was used).
 *
 * Only registered in the temp server, not the user's runtime config.
 * @internal
 */
export function createCloudflareProtocolStubPlugin(): Plugin {
  return {
    name: "@rangojs/router:cloudflare-protocol-stub",
    enforce: "pre",
    resolveId(id) {
      if (id.startsWith("cloudflare:")) {
        return STUB_PREFIX + id;
      }
      return null;
    },
    load(id) {
      if (!id.startsWith(STUB_PREFIX)) return null;
      const specifier = id.slice(STUB_PREFIX.length);
      if (specifier === "cloudflare:workers") {
        return CLOUDFLARE_WORKERS_STUB;
      }
      throw new Error(
        `[rsc-router] Unsupported \`${specifier}\` import encountered during router discovery. ` +
          `Only \`cloudflare:workers\` is stubbed today. ` +
          `Add a stub for \`${specifier}\` in packages/rangojs-router/src/vite/plugins/cloudflare-protocol-stub.ts, ` +
          `or move the import out of the module graph that reaches the worker entry.`,
      );
    },
  };
}

const CLOUDFLARE_WORKERS_STUB = `
export class DurableObject { constructor(_ctx, _env) {} }
export class WorkerEntrypoint { constructor(_ctx, _env) {} }
export class WorkflowEntrypoint { constructor(_ctx, _env) {} }
export class RpcTarget {}
export const env = {};
export default {};
`;
