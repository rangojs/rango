// Data for serve-shell-request.rsc-test.tsx. Every value carries the source
// generation it was computed from, so a value the shell captured is visibly
// different from one read after the source moved on. getProduct is a
// "use cache" function (wrapped by rangoUseCacheTransform() in
// vitest.rsc.config.ts) that tags its entry with its product.
import { cacheTag } from "../../../cache/cache-tag.js";
import {
  createHandle,
  createLoader,
  type Handle,
  type LoaderContext,
  type LoaderDefinition,
} from "../../../index.rsc.js";

export const source: { generation: number } = { generation: 1 };

export async function getProduct(id: string): Promise<string> {
  "use cache";
  cacheTag(`product:${id}`);
  return `product-${id}@g${source.generation}`;
}

/** Read by a layout (the shell) and a loader under loading() (a hole). */
export async function getStamp(): Promise<string> {
  "use cache";
  return `stamp@g${source.generation}`;
}

/** A handle only CachedDepLoader pushes to. */
const DepNotes = createHandle<string>();

/** Awaited inside readCachedDep: its push rides that entry, owned by it. */
const CachedDepLoader = createLoader(async (ctx) => {
  ctx.use(DepNotes)(`dep-note@g${source.generation}`);
  return { dep: `dep@g${source.generation}` };
});

/**
 * A "use cache" function that awaits a loader: on a hit it replays the
 * loader's push inside the caller's loader body.
 */
export async function readCachedDep(ctx: LoaderContext): Promise<string> {
  "use cache";
  const { dep } = await ctx.use(CachedDepLoader);
  return dep;
}

/** A handle only RecaptureLiveLoader pushes to. */
export const RecaptureNotes: Handle<string> = createHandle<string>();

/** Registered live on /recapture-live; readRecaptureLive awaits it too. */
export const RecaptureLiveLoader: LoaderDefinition<{
  recaptureLive: string;
}> = createLoader(async (ctx) => {
  ctx.use(RecaptureNotes)(`recapture-note@g${source.generation}`);
  return { recaptureLive: `recapture-live@g${source.generation}` };
});

/**
 * A "use cache" function that awaits the live loader. Called only during a
 * capture, where the live loader is masked, so its entry records the live
 * loader's push; a recapture's hit replays it inside the caller's body.
 */
export async function readRecaptureLive(ctx: LoaderContext): Promise<string> {
  "use cache";
  const { recaptureLive } = await ctx.use(RecaptureLiveLoader);
  return recaptureLive;
}
