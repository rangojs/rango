"use client";

import type { ReactNode } from "react";

interface RenderErrorThrowerProps {
  error: unknown;
}

/**
 * Client component that throws the given error during render, so the nearest
 * error boundary catches it. Errors thrown during render are caught by error
 * boundaries; async errors (rejected promises) are not -- which is why the
 * navigation bridge funnels processing failures through this component instead
 * of letting them surface as uncaught rejections.
 */
export function RenderErrorThrower({
  error,
}: RenderErrorThrowerProps): ReactNode {
  throw error;
}
