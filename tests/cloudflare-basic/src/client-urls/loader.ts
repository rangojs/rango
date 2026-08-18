import { createLoader } from "@rangojs/router";

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
