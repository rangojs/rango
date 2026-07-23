import { createLoader } from "@rangojs/router";

// Fetchable loader (second arg `true`) used only by the trace-spans e2e to
// exercise the standalone _rsc_loader endpoint — the path useFetchLoader().load()
// hits, which executes the loader directly instead of via the render-time
// resolveLoaderData path. Not wired into any route. worker.rsc.tsx imports it to
// serve its $$id on the ?__trace_probe_id test route; that import is no longer
// required for the _rsc_loader endpoint to resolve it — the loader manifest
// (bundled into the worker entry by version-injector) registers every fetchable
// loader. See the orphan-fetchable fixture for the no-import case.
export const TraceProbeLoader = createLoader(
  async (): Promise<{ probe: string }> => {
    return { probe: "ok" };
  },
  true,
);
