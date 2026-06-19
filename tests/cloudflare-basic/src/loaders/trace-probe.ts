import { createLoader } from "@rangojs/router";

// Fetchable loader (second arg `true`) used only by the trace-spans e2e to
// exercise the standalone _rsc_loader endpoint — the path useFetchLoader().load()
// hits, which executes the loader directly instead of via the render-time
// resolveLoaderData path. Registered through the worker entry import so the
// _rsc_loader endpoint can resolve it. Not wired into any route.
export const TraceProbeLoader = createLoader(
  async (): Promise<{ probe: string }> => {
    return { probe: "ok" };
  },
  true,
);
