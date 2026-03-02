"use client";

import { useEffect, useRef } from "react";
import { useLocationState, Link } from "@rangojs/router/client";
import { SlowProductLocationState } from "../location-states.js";

/**
 * Displays typed state from SlowProductLocationState
 * (read via useLocationState with a definition)
 */
export function TypedStateDisplay() {
  const product = useLocationState(SlowProductLocationState);
  return (
    <div data-testid="typed-state">
      {product ? (
        <>
          <p data-testid="typed-product-name">{product.productName}</p>
          <p data-testid="typed-product-price">{product.productPrice}</p>
        </>
      ) : (
        <p data-testid="typed-state-empty">No typed state</p>
      )}
    </div>
  );
}

/**
 * Displays plain state from history.state.state
 * (read via useLocationState() without a definition)
 */
export function PlainStateDisplay() {
  const state = useLocationState<{ from?: string; count?: number }>();
  return (
    <div data-testid="plain-state">
      {state ? (
        <>
          <p data-testid="plain-from">{state.from}</p>
          {state.count !== undefined && (
            <p data-testid="plain-count">{state.count}</p>
          )}
        </>
      ) : (
        <p data-testid="plain-state-empty">No plain state</p>
      )}
    </div>
  );
}

/**
 * Typed JIT state link — must be a client component because
 * the getter function cannot serialize across the RSC boundary.
 */
export function TypedJitLink() {
  return (
    <Link
      to="/location-state/link-state/target"
      state={[
        SlowProductLocationState(() => ({
          productName: "JIT Product",
          productPrice: 99,
        })),
      ]}
      data-testid="link-typed-jit"
    >
      Typed JIT state
    </Link>
  );
}

/**
 * Plain JIT state link — must be a client component because
 * the state prop is a function (cannot serialize across RSC boundary).
 */
export function PlainJitLink() {
  return (
    <Link
      to="/location-state/link-state/plain-target"
      state={() => ({ from: "jit", count: 7 })}
      data-testid="link-plain-jit"
    >
      Plain JIT state
    </Link>
  );
}

/**
 * Typed JIT state link that proves the getter runs at click time,
 * not at render time.
 *
 * Uses a mutable ref that starts at 0 during render and is set to 42
 * in useEffect (after mount). The getter reads the ref:
 * - If resolved at render time: productPrice = 0 (ref not yet updated)
 * - If resolved at click time: productPrice = 42 (ref updated by effect)
 */
export function TypedJitTimingLink() {
  const postMountValue = useRef(0);

  useEffect(() => {
    postMountValue.current = 42;
  }, []);

  return (
    <Link
      to="/location-state/link-state/target"
      state={[
        SlowProductLocationState(() => ({
          productName: "JIT Timing",
          productPrice: postMountValue.current,
        })),
      ]}
      data-testid="link-typed-jit-timing"
    >
      Typed JIT timing test
    </Link>
  );
}
