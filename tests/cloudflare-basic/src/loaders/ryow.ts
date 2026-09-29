import { cacheTag, createLoader } from "@rangojs/router";

/** Every /ryow-action tag starts with it (slow-marker-store.ts filters on it). */
export const RYOW_TAG_PREFIX = "ryow-";

/** The /ryow-action loader's tag for an e2e probe (one per run). */
export function ryowTag(probe: string): string {
  return `${RYOW_TAG_PREFIX}${probe}`;
}

// /ryow-action/:probe (see urls.tsx), cached on the slow-marker store.
// `loadedAt` is per run: an unchanged value is a HIT.
export const RyowLoader = createLoader(async (ctx) => {
  cacheTag(ryowTag(ctx.params.probe ?? "none"));
  return { loadedAt: `${Date.now()}-${crypto.randomUUID().slice(0, 8)}` };
});
