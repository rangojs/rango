"use client";

import { useContext, useState, useEffect, useRef } from "react";
import { NavigationStoreContext } from "./context.js";
import { shallowEqual } from "./shallow-equal.js";

/**
 * Hook to access the current route params.
 *
 * Returns the merged route params from the matched route.
 * Updates when navigation completes, not during pending navigation.
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
// underlying params map unchanged.
export function useParams<
  T extends object = Record<string, string>,
>(): Readonly<T>;
export function useParams<T>(
  selector: (params: Record<string, string>) => T,
): T;
export function useParams<T>(
  selector?: (params: Record<string, string>) => T,
): T | Record<string, string> {
  const ctx = useContext(NavigationStoreContext);

  const [value, setValue] = useState<T | Record<string, string>>(() => {
    if (!ctx) {
      return selector ? selector({}) : {};
    }
    const params = ctx.eventController.getParams();
    return selector ? selector(params) : params;
  });

  const prevValue = useRef(value);
  // Ref keeps the latest selector without re-subscribing. Event-driven by
  // design: value updates on store events, not on selector identity change.
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  useEffect(() => {
    if (!ctx) return;

    const update = () => {
      const params = ctx.eventController.getParams();
      const next = selectorRef.current ? selectorRef.current(params) : params;

      if (!shallowEqual(next, prevValue.current)) {
        prevValue.current = next;
        setValue(next);
      }
    };

    update();

    return ctx.eventController.subscribe(update);
  }, []);

  return value;
}
