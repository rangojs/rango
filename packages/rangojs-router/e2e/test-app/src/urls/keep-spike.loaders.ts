import { createLoader, type LoaderContext } from "@rangojs/router";
import { getKeepSpikeActs } from "./keep-spike.store.js";

// SPIKE (kept pages, part C): one loader per page, answering after a
// 400 ms server delay. The answer names the page, how many times this
// page's loader ran for its variant, and the variant's action count, so a
// frame shows whose data it drew and how old it is.

const SERVER_DELAY_MS = 400;
const runs = new Map<string, number>();

async function answer(page: string, ctx: LoaderContext): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, SERVER_DELAY_MS));
  const variant = ctx.pathname.split("/")[2] ?? "";
  const key = `${variant}:${page}`;
  const run = (runs.get(key) ?? 0) + 1;
  runs.set(key, run);
  return `${page} run=${run} acts=${getKeepSpikeActs(variant)}`;
}

export const KeepSpikeALoader = createLoader((ctx) => answer("a", ctx));
export const KeepSpikeBLoader = createLoader((ctx) => answer("b", ctx));
export const KeepSpikeCLoader = createLoader((ctx) => answer("c", ctx));
