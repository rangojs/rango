"use client";

import { ViewTransition, useEffect, useState, type ReactNode } from "react";
import {
  useLoader,
  useFetchLoader,
  useRefreshLoaders,
  type LoaderDefinition,
} from "@rangojs/router/client";
import { RevenueLoader, type Metric } from "../loaders/metrics.js";

const card: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  padding: "16px 18px",
  minWidth: 190,
  background: "#fff",
};
const head: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  fontSize: 13,
  color: "#6b7280",
  marginBottom: 6,
};
const valueStyle: React.CSSProperties = {
  fontSize: 30,
  fontWeight: 700,
  letterSpacing: "-0.02em",
};
const meta: React.CSSProperties = {
  fontSize: 12,
  color: "#9ca3af",
  marginTop: 4,
};
const badge: React.CSSProperties = {
  fontSize: 11,
  color: "#9a6700",
  background: "#fff8c5",
  borderRadius: 999,
  padding: "1px 8px",
};
const button: React.CSSProperties = {
  marginTop: 12,
  fontSize: 13,
  padding: "6px 12px",
  borderRadius: 8,
  border: "1px solid #d1d5db",
  background: "#f9fafb",
  cursor: "pointer",
};

function CardShell({
  id,
  label,
  value,
  calls,
  isLoading,
  button: btn,
}: {
  id: string;
  label: string;
  value?: string;
  calls?: number;
  isLoading: boolean;
  button?: ReactNode;
}) {
  return (
    <div data-testid={`vt-card-${id}`} style={card} aria-busy={isLoading}>
      <div style={head}>
        <span>{label}</span>
        {isLoading && (
          <span data-testid={`vt-card-${id}-busy`} style={badge}>
            refreshing…
          </span>
        )}
      </div>
      {/* The value is wrapped in a named ViewTransition. When the keyed / group
          refresh commits a new value inside startTransition, React cross-fades
          the old value out and the new one in. Keying the inner node by value
          makes each value a distinct element so the swap animates. */}
      <ViewTransition name={`vt-value-${id}`}>
        <div
          data-testid={`vt-card-${id}-value`}
          key={value ?? "—"}
          style={valueStyle}
        >
          {value ?? "—"}
        </div>
      </ViewTransition>
      <div style={meta}>
        loader calls:{" "}
        <span data-testid={`vt-card-${id}-calls`}>{calls ?? "—"}</span>
      </div>
      {btn}
    </div>
  );
}

/** Shared-key card — two of these read RevenueLoader with key="revenue"; a
 * refresh from one cross-fades BOTH. */
export function VtSharedKeyCard({
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
      isLoading={isLoading}
      button={
        withButton ? (
          <button
            data-testid={`vt-card-${id}-refresh`}
            style={button}
            onClick={() => load().catch(() => {})}
          >
            Refresh (key: revenue)
          </button>
        ) : null
      }
    />
  );
}

/** Group card — an unregistered fetch loader tagged into refreshGroup="metrics".
 * Auto-loads once, then cross-fades together with its group. */
export function VtGroupCard({
  id,
  label,
  loader,
}: {
  id: string;
  label: string;
  loader: LoaderDefinition<Metric>;
}) {
  const { data, isLoading, load } = useFetchLoader(loader, {
    refreshGroup: "metrics",
  });
  useEffect(() => {
    if (data === undefined) load().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot initial load
  }, []);
  return (
    <CardShell
      id={id}
      label={data?.label ?? label}
      value={data?.value}
      calls={data?.calls}
      isLoading={isLoading}
    />
  );
}

/** One useRefreshLoaders("metrics")() call cross-fades every group member. */
export function VtGroupRefreshButton() {
  const refresh = useRefreshLoaders("metrics");
  const [pending, setPending] = useState(false);
  return (
    <button
      data-testid="vt-group-refresh"
      style={{ ...button, marginTop: 0 }}
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          await refresh();
        } catch {
          /* members surface their own error */
        } finally {
          setPending(false);
        }
      }}
    >
      {pending ? "Refreshing…" : 'Refresh group "metrics"'}
    </button>
  );
}
