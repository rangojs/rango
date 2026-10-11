"use server";

import { countRun } from "../prefetch-false-counts.js";

/**
 * A server action of the /prefetch-false clientUrls() group: it only counts
 * its run (`cu/action`), so a suite can send one while a fill is in flight.
 */
export async function pfCuAction(run: string): Promise<void> {
  countRun(run, "cu/action");
}
