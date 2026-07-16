export const CACHE_LAB_TAGS = {
  catalog: "cache-lab:catalog",
  productAlpha: "cache-lab:product:alpha",
  productBeta: "cache-lab:product:beta",
  shell: "cache-lab:shell",
} as const;

export const CACHE_LAB_ALLOWED_TAGS: readonly string[] =
  Object.values(CACHE_LAB_TAGS);

export type CacheLabProductId = "alpha" | "beta";

export interface CacheLabProductSnapshot {
  cacheToken: string;
  generatedAt: string;
  id: CacheLabProductId;
  name: string;
  price: string;
  tags: readonly string[];
}

export function cacheLabProductTag(id: CacheLabProductId): string {
  return id === "alpha"
    ? CACHE_LAB_TAGS.productAlpha
    : CACHE_LAB_TAGS.productBeta;
}
