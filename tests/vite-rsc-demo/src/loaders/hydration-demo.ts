import { createLoader, createLocationState } from "@rangojs/router";
import { HydrationNotes } from "../handles/hydration-notes.js";

/**
 * Pushes its note after an await, so the push misses the handler barrier: it is
 * not in the document's handle snapshot and reaches the browser on the late
 * handle channel while the page is still hydrating (issue #1035). `?delay=`
 * (ms, default 800) sets how long it takes.
 */
export const LateNoteLoader = createLoader(async (ctx) => {
  const delay = Number(ctx.searchParams.get("delay") ?? 800);
  await new Promise((resolve) => setTimeout(resolve, delay));
  ctx.use(HydrationNotes)("late note from the loader");
  return { message: "loader data streamed in" };
});

export interface HydrationDemoState {
  label: string;
}

/** Location state read inside a late Suspense boundary (issue #992). */
export const HydrationDemoLocationState =
  createLocationState<HydrationDemoState>();
