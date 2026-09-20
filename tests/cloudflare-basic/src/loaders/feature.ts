import { createLoader } from "@rangojs/router";

const FEATURE_LOADER_DELAY = 800;

export interface FeatureLoaderData {
  slug: string;
  loadedAt: string;
}

// Same-route hold probe for /features/:slug: slow enough that a feature ->
// feature navigation streams it while the previous content is held, so a
// useLoader reader can report isLoading:true for the data still on screen.
export const FeatureLoader = createLoader(
  async (ctx): Promise<FeatureLoaderData> => {
    await new Promise((resolve) => setTimeout(resolve, FEATURE_LOADER_DELAY));
    return {
      slug: ctx.params.slug as string,
      loadedAt: new Date().toISOString(),
    };
  },
);

export interface FeatureShellLoaderData {
  label: string;
  loadedAt: string;
}

// Layout loader on FeaturesShell (persists across /features/:slug navs). A
// same-route nav does NOT re-run it, so its useLoader reader must stay
// isLoading:false while FeatureLoader streams (e2e/loader-nav-stale.test.ts).
export const FeatureShellLoader = createLoader(
  async (): Promise<FeatureShellLoaderData> => {
    return { label: "shell", loadedAt: new Date().toISOString() };
  },
);
