import { createHandle, createLoader } from "@rangojs/router";

// Late-push history fixture (e2e late-handle-history.test.ts): the note loader
// pushes after an await (?noteDelay ms, default 300), so the push misses the
// handler barrier and reaches the browser on the late handle channel. The slow
// loader holds the route's loading() boundary (and with it the hydration
// window) open after the push.
export const LateHistoryNotes = createHandle<string>();

export const LateHistoryNoteLoader = createLoader(async (ctx) => {
  const delay = Number(ctx.searchParams.get("noteDelay") ?? 300);
  await new Promise((resolve) => setTimeout(resolve, delay));
  ctx.use(LateHistoryNotes)("late history note");
  return { ok: true };
});

export const LateHistorySlowLoader = createLoader(async (ctx) => {
  const delay = Number(ctx.searchParams.get("delay") ?? 8000);
  await new Promise((resolve) => setTimeout(resolve, delay));
  return { value: "slow boundary resolved" };
});
