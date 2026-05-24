"use client";

import { Suspense, use, useEffect, useState, type ReactNode } from "react";
import {
  useLoader,
  useFetchLoader,
  useRefreshLoaders,
  type LoaderDefinition,
} from "@rangojs/router/client";
import { RevenueLoader } from "../../handlers/refresh-demo/loaders.js";

interface MetricData {
  label: string;
  value: string;
  calls: number;
  at: string;
}

// A promise per (card, value) so the card body genuinely SUSPENDS whenever a
// DEFINED value changes — this is what makes the Suspense fallback
// re-triggerable, and therefore what proves the hook commits new data inside
// startTransition (a refresh must NOT flash the fallback). The pre-first-load
// `undefined` state renders a plain skeleton directly (see CardValue) rather
// than suspending — a never-resolving promise would hang streaming SSR.
const valueGate = new Map<string, Promise<unknown>>();
function gateFor(cardId: string, value: string): Promise<unknown> {
  const k = `${cardId}::${value}`;
  let p = valueGate.get(k);
  if (!p) {
    p = new Promise((resolve) => setTimeout(resolve, 120));
    valueGate.set(k, p);
  }
  return p;
}

const skeletonBarStyle: React.CSSProperties = {
  height: 28,
  width: 110,
  borderRadius: 6,
  background: "linear-gradient(90deg,#eaeef2 25%,#f6f8fa 37%,#eaeef2 63%)",
};

function SkeletonBar({ testid }: { testid: string }) {
  return <div data-testid={testid} style={skeletonBarStyle} />;
}

const cardStyle: React.CSSProperties = {
  border: "1px solid #d0d7de",
  borderRadius: 10,
  padding: "14px 16px",
  minWidth: 180,
  background: "#fff",
  boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
};
const headStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  fontSize: 13,
  color: "#57606a",
  marginBottom: 6,
};
const valueStyle: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 700,
  fontVariantNumeric: "tabular-nums",
};
const metaStyle: React.CSSProperties = { fontSize: 12, color: "#8b949e" };
const badgeStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#9a6700",
  background: "#fff8c5",
  borderRadius: 999,
  padding: "1px 8px",
};
const buttonStyle: React.CSSProperties = {
  marginTop: 10,
  fontSize: 13,
  padding: "6px 10px",
  borderRadius: 7,
  border: "1px solid #d0d7de",
  background: "#f6f8fa",
  cursor: "pointer",
};

/** Renders a plain skeleton before the first value arrives; once a value
 * exists, suspends on each value change via gateFor() so updates cross through a
 * real Suspense boundary. `use` may be called conditionally. */
function CardValue({ id, value }: { id: string; value?: string }) {
  if (value === undefined) {
    return <SkeletonBar testid={`rl-card-${id}-skeleton`} />;
  }
  use(gateFor(id, value));
  return (
    <div data-testid={`rl-card-${id}-value`} style={valueStyle}>
      {value}
    </div>
  );
}

function CardShell({
  id,
  label,
  value,
  calls,
  at,
  isLoading,
  button,
}: {
  id: string;
  label: string;
  value?: string;
  calls?: number;
  at?: string;
  isLoading: boolean;
  button?: ReactNode;
}) {
  return (
    <div style={cardStyle} data-testid={`rl-card-${id}`} aria-busy={isLoading}>
      <div style={headStyle}>
        <span>{label}</span>
        {isLoading && (
          <span data-testid={`rl-card-${id}-refreshing`} style={badgeStyle}>
            refreshing…
          </span>
        )}
      </div>
      <div style={{ opacity: isLoading ? 0.45 : 1, transition: "opacity .2s" }}>
        <Suspense fallback={<SkeletonBar testid={`rl-card-${id}-skeleton`} />}>
          <CardValue id={id} value={value} />
        </Suspense>
      </div>
      <div style={metaStyle}>
        server calls:{" "}
        <span data-testid={`rl-card-${id}-calls`}>{calls ?? "—"}</span> ·
        updated {at ?? "—"}
      </div>
      {button}
    </div>
  );
}

/**
 * Shared-key card — a registered ("pure") loader read via useLoader with a
 * shared `key`. Two of these on the page use the same key, so a refresh from
 * one updates BOTH.
 */
export function SharedKeyCard({
  id,
  withButton = false,
}: {
  id: string;
  withButton?: boolean;
}) {
  const { data, isLoading, load } = useLoader(RevenueLoader, {
    key: "revenue",
  });
  return (
    <CardShell
      id={id}
      label={data.label}
      value={data.value}
      calls={data.calls}
      at={data.at}
      isLoading={isLoading}
      button={
        withButton ? (
          <button
            data-testid={`rl-card-${id}-refresh`}
            style={buttonStyle}
            onClick={() => load().catch(() => {})}
          >
            load() · key: revenue
          </button>
        ) : null
      }
    />
  );
}

/**
 * Group card — an unregistered ("fetch") loader read via useFetchLoader, tagged
 * into a refreshGroup. Auto-loads once on mount (so the value streams in behind
 * the fallback), then refreshes together with its group.
 */
export function GroupCard({
  id,
  label,
  loader,
}: {
  id: string;
  label: string;
  loader: LoaderDefinition<MetricData>;
}) {
  const { data, isLoading, load } = useFetchLoader(loader, {
    refreshGroup: "metrics",
  });
  useEffect(() => {
    if (data === undefined) load().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot initial stream
  }, []);
  return (
    <CardShell
      id={id}
      label={data?.label ?? label}
      value={data?.value}
      calls={data?.calls}
      at={data?.at}
      isLoading={isLoading}
    />
  );
}

/** Refreshes every loader tagged with refreshGroup="metrics" in one call. */
export function GroupRefreshButton() {
  const refresh = useRefreshLoaders("metrics");
  const [pending, setPending] = useState(false);
  return (
    <button
      data-testid="rl-group-refresh"
      style={{ ...buttonStyle, marginTop: 0 }}
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          await refresh();
        } catch {
          /* members surface their own error; ignore here */
        } finally {
          setPending(false);
        }
      }}
    >
      {pending ? "Refreshing group…" : 'Refresh group "metrics"'}
    </button>
  );
}
