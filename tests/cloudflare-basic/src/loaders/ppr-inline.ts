import { createLoader } from "@rangojs/router";

// Issue #1206 fixture: a ppr route with an ssr: false loader and a completed
// Suspense boundary past both Fizz outlining gates (PprInlineView). The live
// render and the shell capture both keep it in place. `live` is a promise, so
// the shell has a hole and a HIT resumes it.

export interface PprInlineData {
  live: Promise<string>;
}

export const PprInlineLoader = createLoader(
  async (): Promise<PprInlineData> => ({
    live: Promise.resolve("inline live"),
  }),
);
