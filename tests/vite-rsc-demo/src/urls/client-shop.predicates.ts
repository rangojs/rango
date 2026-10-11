import type { RevalidateParams } from "@rangojs/router";

/**
 * Product data changes on slug changes, never on tab switches or cart
 * actions. A blunt `() => false` kept serving the OLD product's data on
 * product→product navs (same route, new param); the predicate must be
 * param-sensitive, exactly like the server shop's revalidation.
 *
 * Its own module, not client-shop.client.tsx: a clientUrls() revalidate()
 * runs on the server, so a predicate shared by several loaders is imported
 * from a module without "use client".
 */
export function productData({
  isAction,
  currentParams,
  nextParams,
  defaultShouldRevalidate,
}: RevalidateParams): boolean {
  if (isAction()) return false;
  return currentParams.slug !== nextParams.slug
    ? defaultShouldRevalidate
    : false;
}
