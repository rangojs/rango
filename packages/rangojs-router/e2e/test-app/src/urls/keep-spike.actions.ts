"use server";

import { bumpKeepSpikeActs } from "./keep-spike.store.js";

// SPIKE (kept pages, part C): an action taken while page A is hidden; the
// page on screen revalidates, page A's loader reads the count on its show.
export async function keepSpikeAct(variant: string): Promise<number> {
  return bumpKeepSpikeActs(variant);
}
