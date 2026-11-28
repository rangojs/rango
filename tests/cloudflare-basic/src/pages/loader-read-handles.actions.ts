"use server";

import { bumpLoaderReadHandlesTally } from "./loader-read-handles.store.js";

/** How long the tally loader's re-run holds its data back. */
const TALLY_HOLD_MS = 2000;

/**
 * Bumps the tally of /loader-read-handles/kept. The tally loader's re-run
 * then holds its data back for TALLY_HOLD_MS, so the action's response stays
 * open after the browser built its tree from the rows it has.
 */
export async function bumpLoaderReadHandlesTallySlowly(): Promise<number> {
  return bumpLoaderReadHandlesTally(TALLY_HOLD_MS);
}
