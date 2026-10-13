"use server";

import { breakSettledLaneStock } from "./settled-lane-errors.state.js";

// Its run's flaky loader throws from now on; the action also marks every
// history entry stale (e2e/settled-lane-errors.test.ts).
export async function settledLaneBreak(run: string): Promise<string> {
  breakSettledLaneStock(run);
  return "broken";
}
