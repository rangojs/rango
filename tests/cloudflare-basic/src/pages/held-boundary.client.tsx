"use client";

import { useLoader } from "@rangojs/router/client";
import {
  ZlbLayoutLoader,
  ZlbRouteLoader,
  ZlbSlotLoader,
} from "./held-boundary.loaders.js";

export function ZlbLayoutValue() {
  const { data } = useLoader(ZlbLayoutLoader);
  return <span data-testid="zlbl-value">{data.value}</span>;
}

export function ZlbSlotValue() {
  const { data } = useLoader(ZlbSlotLoader);
  return <span data-testid="zlbs-slot-value">{data.value}</span>;
}

export function ZlbRouteValue() {
  const { data } = useLoader(ZlbRouteLoader);
  return <span>{data.value}</span>;
}
