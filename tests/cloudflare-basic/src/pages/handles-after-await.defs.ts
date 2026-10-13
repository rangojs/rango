import { Breadcrumbs, createLoader, Meta } from "@rangojs/router";

// Handles pushed after an await (e2e handles-after-await.test.ts): every
// writer below waits HAA_WAIT_MS, then pushes a Meta title and a crumb.
export const HAA_WAIT_MS = 1000;

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let loaderRuns = 0;

/** Case 3: a loader body that pushes after its await; the page reads it. */
export const HaaAwaitLoader = createLoader(async (ctx) => {
  const v = ctx.searchParams.get("v") ?? "1";
  await wait(HAA_WAIT_MS);
  loaderRuns += 1;
  ctx.use(Meta)({ title: `Loader ${v}` });
  ctx.use(Breadcrumbs)({
    label: `Loader ${v}`,
    href: "/handles-after-await/loader",
  });
  return { v, run: loaderRuns };
});
