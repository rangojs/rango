import { createLoader } from "@rangojs/router";

export interface GuidePlainLoaderData {
  // Per-call-unique: proves the loader re-runs on every request even when the
  // route payload is served frozen from the on-demand prerender overlay.
  value: string;
}

export const GuidePlainLoader = createLoader(
  async (): Promise<GuidePlainLoaderData> => {
    return {
      value: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    };
  },
);
