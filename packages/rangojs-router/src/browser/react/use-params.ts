"use client";

import { useContext, useState, useEffect, useRef } from "react";
import { NavigationStoreContext } from "./context.js";
import { getSsrParams } from "./use-segments.js";

/**
 * Shallow equality check for selector results
 */
function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    a === null ||
    typeof b !== "object" ||
    b === null
  ) {
    return false;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (
      !Object.hasOwn(b, key) ||
      !Object.is(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      )
    ) {
      return false;
    }
  }
  return true;
}

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
 * // With selector
 * const productId = useParams(p => p.productId);
 * ```
 */
export function useParams(): Record<string, string>;
export function useParams<T>(
  selector: (params: Record<string, string>) => T,
): T;
export function useParams<T>(
  selector?: (params: Record<string, string>) => T,
): T | Record<string, string> {
  const ctx = useContext(NavigationStoreContext);

  const [value, setValue] = useState<T | Record<string, string>>(() => {
    if (typeof document === "undefined" || !ctx) {
      const ssrParams = getSsrParams();
      return selector ? selector(ssrParams) : ssrParams;
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
