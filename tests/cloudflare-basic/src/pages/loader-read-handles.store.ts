// The /loader-read-handles/kept fixture's tally (loader-read-handles.tsx): a
// count its action bumps, and how long the tally loader's next run holds its
// data back. The action and the re-run it causes share one request, so one
// isolate.
let tally = 0;
let holdNextRun = 0;

/** Bumps the tally; the tally loader's next run waits `holdMs` first. */
export function bumpLoaderReadHandlesTally(holdMs: number): number {
  holdNextRun = holdMs;
  return ++tally;
}

/** The tally, after the hold the last bump asked for (taken once). */
export async function readLoaderReadHandlesTally(): Promise<number> {
  const hold = holdNextRun;
  holdNextRun = 0;
  if (hold > 0) await new Promise((resolve) => setTimeout(resolve, hold));
  return tally;
}
