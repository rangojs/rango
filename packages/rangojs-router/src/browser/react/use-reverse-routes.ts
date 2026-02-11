import { useMemo } from "react";
import { createReverse, type ReverseFunction } from "../../reverse.js";

export function useReverseRoutes<TRoutes extends Record<string, string>>(
  routes: TRoutes
): ReverseFunction<TRoutes> {
  return useMemo(() => createReverse(routes), [routes]);
}
