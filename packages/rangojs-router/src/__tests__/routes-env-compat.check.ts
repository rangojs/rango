/**
 * Compile-only assertions for routes() env compatibility (EnvCompatible).
 *
 * Type-checked by the main tsc pass; never executed (vitest only runs *.test.*,
 * and this is wrapped in an unused function so nothing runs at import time).
 * Guards against regressing the env-agnostic-vs-concrete distinction in
 * router-interfaces.ts / pattern-types.ts.
 */
import { createRouter } from "../router.js";
import { urls } from "../urls/urls-function.js";

export function _routesEnvCompatChecks(): void {
  // A urls<TEnv>() block carrying a concrete env mounts on a router whose env
  // satisfies it.
  const needsDb = urls<{ DB: { query(sql: string): unknown } }>(() => []);
  createRouter<{ DB: { query(sql: string): unknown }; KV: unknown }>().routes(
    needsDb,
  );

  // @ts-expect-error - router env {} does not satisfy the urls<{ DB }>() env
  createRouter<{}>().routes(needsDb);

  // Note: a union router env (`createRouter<A | B>()`) is NOT covered here — the
  // distributive EnvCompatible accepts it (documented limitation in
  // pattern-types.ts). A router has a single env, so a union env is unsupported.

  // An env-agnostic urls() block (its env resolves to unknown here) mounts on
  // any router.
  const envAgnostic = urls(() => []);
  createRouter<{}>().routes(envAgnostic);
}
