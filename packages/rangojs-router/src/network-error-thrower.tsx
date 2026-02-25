"use client";

import type { ReactNode } from "react";
import type { NetworkError } from "./errors.js";

interface NetworkErrorThrowerProps {
  error: NetworkError;
}

/**
 * Client component that throws a NetworkError during render.
 * Used to trigger the root error boundary when a network error occurs
 * during navigation or server actions.
 *
 * This must be a separate component because:
 * 1. Errors must be thrown during React's render phase to be caught by error boundaries
 * 2. The error occurs in async code (fetch), so we need to propagate it to React's render
 */
export function NetworkErrorThrower({
  error,
}: NetworkErrorThrowerProps): ReactNode {
  throw error;
}
