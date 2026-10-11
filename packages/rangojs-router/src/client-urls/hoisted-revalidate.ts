/**
 * The value the build leaves in place of a clientUrls() `revalidate()`
 * predicate in the browser and SSR copies of a "use client" module
 * (vite/plugins/client-urls-revalidate-hoist.ts): the predicate itself moves
 * to a server module, registered under the same content key
 * (revalidate-registry.ts). The projection carries the key; the materialized
 * loader stub calls the registered predicate.
 */

export const HOISTED_REVALIDATE_KEY = "$$rangoRevalidate";

export interface HoistedRevalidateRef {
  readonly $$rangoRevalidate: string;
}

export function isHoistedRevalidateRef(
  value: unknown,
): value is HoistedRevalidateRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<HoistedRevalidateRef>)[HOISTED_REVALIDATE_KEY] ===
      "string"
  );
}
