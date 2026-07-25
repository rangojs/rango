"use client";

import { useEffect, useState } from "react";
import { useLoader } from "@rangojs/router/client";
import {
  FastStatsLoader,
  MediumActivityLoader,
  SlowReportLoader,
} from "../loaders/suspense-demo.js";
import type { SuspenseDemoData } from "../loaders/suspense-demo.js";

/**
 * Each card reads ONE loader with useLoader. While that loader's data is
 * still streaming, the read suspends to the card's own Suspense boundary
 * (placed by the page), so cards fill in independently: stats at ~400ms,
 * activity at ~1200ms, report at ~2000ms. `paintedAt` is captured on mount
 * (client clock) — the deltas between cards make the stagger measurable.
 */

/**
 * Client-only paint stamp. SSR renders a stable placeholder — rendering
 * performance.now() during SSR can never match the client's value and
 * guarantees a hydration text mismatch (the initial version of this demo did
 * exactly that). The stamp fills in after mount.
 */
function usePaintedAt(): string {
  const [paintedAt, setPaintedAt] = useState<string>("…");
  useEffect(() => {
    setPaintedAt(`+${Math.round(performance.now())}ms`);
  }, []);
  return paintedAt;
}

function Card({ testid, data }: { testid: string; data: SuspenseDemoData }) {
  const paintedAt = usePaintedAt();
  return (
    <div
      data-testid={testid}
      style={{
        border: "1px solid #2c7",
        borderRadius: 8,
        padding: "0.75rem 1rem",
        marginBottom: "0.5rem",
      }}
    >
      <strong>{data.label}</strong> — loader delay {data.delayMs}ms
      <div>{data.detail}</div>
      <small>
        served {data.servedAt} · painted at client {paintedAt}
      </small>
    </div>
  );
}

export function StatsCard() {
  const { data } = useLoader(FastStatsLoader);
  return <Card testid="sd-stats" data={data} />;
}

export function ActivityCard() {
  const { data } = useLoader(MediumActivityLoader);
  return <Card testid="sd-activity" data={data} />;
}

export function ReportCard() {
  const { data } = useLoader(SlowReportLoader);
  return <Card testid="sd-report" data={data} />;
}

export function CardSkeleton({ label }: { label: string }) {
  return (
    <div
      data-testid={`sd-skeleton-${label}`}
      style={{
        border: "1px dashed #999",
        borderRadius: 8,
        padding: "0.75rem 1rem",
        marginBottom: "0.5rem",
        color: "#999",
      }}
    >
      loading {label}…
    </div>
  );
}
