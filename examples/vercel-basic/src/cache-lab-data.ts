import { cacheTag, createLoader } from "@rangojs/router";
import {
  CACHE_LAB_TAGS,
  cacheLabProductTag,
  type CacheLabProductId,
  type CacheLabProductSnapshot,
} from "./cache-lab-contract.js";

const PRODUCTS: Record<CacheLabProductId, { name: string; price: string }> = {
  alpha: { name: "Edge Runner", price: "$148" },
  beta: { name: "Stream Trainer", price: "$172" },
};

const CACHE_LAB_MISS_DELAY_MS = 450;
const CACHE_LAB_PULSE_DELAY_MS = 650;

export const CacheLabPulseLoader = createLoader(async () => {
  "use server";

  return {
    generatedAt: new Promise<string>((resolve) =>
      setTimeout(
        () => resolve(new Date().toISOString()),
        CACHE_LAB_PULSE_DELAY_MS,
      ),
    ),
  };
});

export async function getCacheLabProduct(
  id: CacheLabProductId,
  probe: string,
): Promise<CacheLabProductSnapshot> {
  "use cache: cache-lab";

  cacheTag(CACHE_LAB_TAGS.catalog, cacheLabProductTag(id));
  await new Promise((resolve) => setTimeout(resolve, CACHE_LAB_MISS_DELAY_MS));

  const product = PRODUCTS[id];
  return {
    cacheToken: `${probe}-${crypto.randomUUID().slice(0, 8)}`,
    generatedAt: new Date().toISOString(),
    id,
    name: product.name,
    price: product.price,
    tags: [CACHE_LAB_TAGS.catalog, cacheLabProductTag(id)],
  };
}
