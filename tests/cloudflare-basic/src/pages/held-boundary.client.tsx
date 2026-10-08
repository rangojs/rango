"use client";

import { useEffect } from "react";
import { useLoader } from "@rangojs/router/client";
import {
  SettledReadLoader,
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

export function SettledReadValue() {
  const { data } = useLoader(SettledReadLoader);
  // Counts the commits that rendered this reader: the e2e waits for it to
  // grow to know a navigation has been rendered.
  useEffect(() => {
    const w = window as unknown as { __settledReadCommits?: number };
    w.__settledReadCommits = (w.__settledReadCommits ?? 0) + 1;
  });
  return <span data-testid="settled-read-value">{data.value}</span>;
}
