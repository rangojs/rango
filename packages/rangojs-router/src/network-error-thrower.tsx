"use client";

import type { ReactNode } from "react";
import type { NetworkError } from "./errors.js";

interface NetworkErrorThrowerProps {
  error: NetworkError;
}

/**
 * Client component that throws a NetworkError during render.
 * Errors thrown during render are caught by error boundaries; async errors are not.
 */
export function NetworkErrorThrower({
  error,
}: NetworkErrorThrowerProps): ReactNode {
  throw error;
}
