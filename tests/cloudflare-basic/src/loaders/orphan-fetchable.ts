import { createLoader } from "@rangojs/router";

// Reproduction fixture for the "orphan fetchable loader" production bug on
// custom worker entries.
//
// This fetchable loader is imported ONLY by the OrphanFetchTest client
// component. It is never imported by worker.rsc.tsx, never registered on a
// route via loader(), and never force-imported anywhere on the server side
// (unlike TraceProbeLoader, which the worker entry imports as a workaround).
//
// On a custom Cloudflare worker entry the loader manifest virtual module is the
// only thing that can register an unreferenced fetchable loader for the
// _rsc_loader endpoint at runtime. Dev resolves the loader by parsing its id
// into a file path; production must rely on the manifest. If the manifest is
// not bundled into the worker, this loader cannot be resolved in production.
// Its implementation imports an RSC-only boundary to verify non-RSC analysis
// receives the loader stub rather than scanning the server callback.
export const OrphanFetchableLoader = createLoader(async (ctx) => {
  // plugin-rsc provides this virtual boundary module during Vite builds.
  // @ts-expect-error "server-only" has no standalone type declaration.
  await import("server-only");
  const id = ctx.params.id ?? "orphan-default";
  return { message: "Orphan fetchable loaded!", id };
}, true);
