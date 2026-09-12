import { createLoader, redirect } from "@rangojs/router";

let isActionTargetRuns = 0;
export const ClientUrlsIsActionTargetLoader = createLoader(async () => {
  isActionTargetRuns += 1;
  return { runs: isActionTargetRuns };
});

let isActionNsRuns = 0;
export const ClientUrlsIsActionNsLoader = createLoader(async () => {
  isActionNsRuns += 1;
  return { runs: isActionNsRuns };
});

export const ClientUrlsDetailLoader = createLoader(
  async (ctx): Promise<{ slug: string }> => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    return { slug: ctx.params.slug ?? "missing-slug" };
  },
);

/** Instant data behind the 5s group middleware (slow.tsx). */
export const ClientUrlsSlowLoader = createLoader(async () => "slow-data");

/** Loader redirect out of the slow group; the middleware gates it too. */
export const ClientUrlsSlowRedirectLoader = createLoader(async () => {
  throw redirect("/client-urls-slow-landing");
});
