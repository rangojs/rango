import { createLoader, type LoaderContext } from "@rangojs/router";

// SPIKE (kept pages, part E): one loader per page of the nested keep routes
// (keep-nested*.tsx), answering after a 400 ms server delay. The answer
// names the page and how many times its loader ran for the variant.

const SERVER_DELAY_MS = 400;
const runs = new Map<string, number>();

async function answer(page: string, ctx: LoaderContext): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, SERVER_DELAY_MS));
  const variant = ctx.pathname.split("/")[2] ?? "";
  const key = `${variant}:${page}`;
  const run = (runs.get(key) ?? 0) + 1;
  runs.set(key, run);
  return `${page} run=${run}`;
}

export const KnA1Loader = createLoader((ctx) => answer("a1", ctx));
export const KnA2Loader = createLoader((ctx) => answer("a2", ctx));
export const KnA3Loader = createLoader((ctx) => answer("a3", ctx));
export const KnB1Loader = createLoader((ctx) => answer("b1", ctx));
export const KnB2Loader = createLoader((ctx) => answer("b2", ctx));
export const KnB3Loader = createLoader((ctx) => answer("b3", ctx));
export const KnC1Loader = createLoader((ctx) => answer("c1", ctx));
export const KnD1Loader = createLoader((ctx) => answer("d1", ctx));
