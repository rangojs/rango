"use client";

import { useLoader } from "@rangojs/router/client";
import { ParallelRevalLoader } from "../loaders.js";

export function ParallelRevalClient() {
  const { data } = useLoader(ParallelRevalLoader);
  return <span data-testid="parallel-reval-count">{data.count}</span>;
}
