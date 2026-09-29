// Data for serve-shell-request.rsc-test.tsx. Every value carries the source
// generation it was computed from, so a value the shell captured is visibly
// different from one read after the source moved on. getProduct is a
// "use cache" function (wrapped by rangoUseCacheTransform() in
// vitest.rsc.config.ts) that tags its entry with its product.
import { cacheTag } from "../../../cache/cache-tag.js";

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
