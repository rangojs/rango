import { createLoader } from "@rangojs/router";

// Reproduction fixture for the "orphan fetchable loader" bug.
//
// This fetchable loader lives in a module that is imported ONLY by the client
// component OrphanFetchLoaderTest.tsx — it is never imported by urls.tsx or any
// other server module, and it is never registered on a route via loader().
//
// In production, a "use client" component's imports are followed in the client
// build (where this file is replaced with a { __brand, $$id } stub), not in the
// RSC build. So this loader's real function code never enters the RSC module
// graph through an import. The only thing that can pull it into the RSC bundle
// (and into the runtime loader manifest used by the _rsc_loader endpoint) is the
// build-time loader pre-scan. If that pre-scan misses it, the production
// endpoint cannot find the loader even though dev resolves it via path parsing.
// Its implementation imports an RSC-only boundary to verify non-RSC analysis
// receives the loader stub rather than scanning the server callback.
let orphanCount = 0;

export const OrphanFetchableLoader = createLoader(async (ctx) => {
  // plugin-rsc provides this virtual boundary module during Vite builds.
  // @ts-expect-error "server-only" has no standalone type declaration.
  await import("server-only");
  orphanCount++;
  const id = ctx.params.id ?? "orphan-default";
  return {
    message: "Orphan fetchable loaded!",
    id,
    count: orphanCount,
  };
}, true);
