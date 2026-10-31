"use client";

import { useContext } from "react";
import { shallowEqual } from "./shallow-equal.js";
import { useUrlValue } from "./use-route-state.js";
import { OptimisticLocationContext } from "../../client-urls/optimistic-location.js";

/**
 * Hook to access the current route params.
 *
 * Returns the merged route params from the matched route.
 * Updates when navigation completes, not during pending navigation — except
 * inside an optimistically rendered clientUrls() destination, where it
 * reports THAT route's params (see OptimisticLocationContext).
 *
 * @example
 * ```tsx
 * // Route: /products/:productId
 * const params = useParams();
 * // { productId: "123" }
 *
 * // Annotate the expected shape via a generic
 * const { productId } = useParams<{ productId: string }>();
 *
 * // With selector
 * const productId = useParams(p => p.productId);
 * ```
 */
// `T extends object` (not `Record<string, string | undefined>`) so that
// interface shapes pass the constraint — interfaces lack an implicit
// index signature and would otherwise be rejected. The generic is a
// shape annotation, not a runtime check; the body always returns the
// underlying params map unchanged. The default and selector input use
// `string | undefined` because absent optional params are omitted from
// the params record at runtime — the type must reflect that so callers
// don't write `p.locale.length` and crash when the segment is absent.
export function useParams<
  T extends object = Record<string, string | undefined>,
>(): Readonly<T>;
export function useParams<T>(
  selector: (params: Record<string, string | undefined>) => T,
): T;
export function useParams<T>(
  selector?: (params: Record<string, string | undefined>) => T,
): T | Record<string, string | undefined> {
  const optimistic = useContext(OptimisticLocationContext);
  const value = useUrlValue<T | Record<string, string>>(
    ({ params }) => (selector ? selector(params) : params),
    shallowEqual,
  );

  if (optimistic) {
    return selector ? selector(optimistic.params) : optimistic.params;
  }
  return value;
}
