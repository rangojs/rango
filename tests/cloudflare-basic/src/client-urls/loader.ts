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

let resultRuns = 0;
export const ClientUrlsResultLoader = createLoader(async () => {
  resultRuns += 1;
  return { runs: resultRuns };
});

// The clientUrls() intercept's modal (intercept.tsx): a loader whose
// revalidate() reads the action's result, and a flagged one.
let modalResultRuns = 0;
export const ClientUrlsModalResultLoader = createLoader(async () => {
  modalResultRuns += 1;
  return { runs: modalResultRuns };
});

let modalNoteRuns = 0;
export const ClientUrlsModalNoteLoader = createLoader(async () => {
  modalNoteRuns += 1;
  return { runs: modalNoteRuns };
});

// revalidate(true) / revalidate(false) probes (urls.tsx): the first re-runs
// on every request, the second renders once and then holds.
let alwaysRuns = 0;
export const ClientUrlsAlwaysLoader = createLoader(async () => {
  alwaysRuns += 1;
  return { runs: alwaysRuns };
});

let heldRuns = 0;
export const ClientUrlsHeldLoader = createLoader(async () => {
  heldRuns += 1;
  return { runs: heldRuns };
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
