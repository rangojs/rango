"use client";

/**
 * Interactive benchmark dashboard: pick any route class, exercise it in three
 * modes (fetch / client navigation / document load), and get median/p90 over
 * N runs plus the server's own Server-Timing breakdown — in the browser,
 * against dev or a deployed edge, without curl.
 *
 * Measurement notes:
 * - fetch mode times performance.now() around fetch + full body read; TTFB
 *   comes from the matching PerformanceResourceTiming entry.
 * - client-nav mode awaits router.push() (resolves when navigation commits),
 *   stores the sample in sessionStorage (the dashboard unmounts mid-nav),
 *   then router.back() restores this page, which re-reads the results.
 * - document mode reports this page's own PerformanceNavigationTiming — the
 *   only honest way to show a full document load without scripting reloads.
 * - Palette: validated categorical slots (see BENCHMARK.md tooling notes);
 *   sub-3:1 slots carry direct labels + the results table as relief.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "@rangojs/router/client";
import { LOCALES, routeClasses, type RouteClass } from "../route-classes.js";
import { parseServerTiming } from "../server-timing.js";

interface Sample {
  ms: number;
  ttfbMs: number | null;
  status: number;
  bytes: number;
  serverTiming: Record<string, number>;
}

interface ResultRow {
  key: string;
  classId: string;
  label: string;
  path: string;
  mode: "fetch" | "nav" | "nav+prefetch";
  flight: boolean;
  n: number;
  ok: boolean;
  medianMs: number;
  p90Ms: number;
  minMs: number;
  maxMs: number;
  ttfbMedianMs: number | null;
  bytes: number;
  status: number;
  serverTiming: Record<string, number>;
}

const STORAGE_KEY = "bench-dashboard-results-v1";

// Server-Timing keys shown as stacked segments, in fixed order. Colors are
// validated categorical slots 1-4 + neutral for the remainder.
const TIMING_SEGMENTS: { key: string; label: string; varName: string }[] = [
  { key: "route-matching", label: "match", varName: "--seg-1" },
  { key: "handler-total", label: "handler", varName: "--seg-2" },
  { key: "pipeline-segment-resolve", label: "resolve", varName: "--seg-3" },
  { key: "rsc-serialize", label: "serialize", varName: "--seg-4" },
];

const CSS = `
body { margin: 0; background: #ffffff; }
@media (prefers-color-scheme: dark) {
  body { background: #1a1a19; }
}
.bench-dash {
  --surface: #ffffff;
  --ink: #111110;
  --ink-2: #52514e;
  --ink-3: #8a887f;
  --line: #e4e2dd;
  --card: #f7f6f3;
  --bar: #2a78d6;
  --seg-1: #2a78d6;
  --seg-2: #1baf7a;
  --seg-3: #eda100;
  --seg-4: #008300;
  --seg-rest: #b5b3aa;
  --good: #0ca30c;
  --bad: #d03b3b;
  color: var(--ink);
  max-width: 960px;
  margin: 0 auto;
  padding: 2rem 1rem;
  font: 14px/1.5 system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) {
  .bench-dash {
    --surface: #1a1a19;
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --ink-3: #8a887f;
    --line: #3a3936;
    --card: #232322;
    --bar: #3987e5;
    --seg-1: #3987e5;
    --seg-2: #199e70;
    --seg-3: #c98500;
    --seg-4: #008300;
    --seg-rest: #55534d;
  }
}
.bench-dash h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
.bench-dash .sub { color: var(--ink-2); margin: 0 0 1.5rem; }
.bench-dash .card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 1rem;
  margin-bottom: 1rem;
}
.bench-dash label { display: block; color: var(--ink-2); font-size: 12px; }
.bench-dash .controls { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: flex-end; }
.bench-dash select, .bench-dash input {
  font: inherit; color: var(--ink); background: var(--surface);
  border: 1px solid var(--line); border-radius: 4px; padding: 0.3rem 0.5rem;
}
.bench-dash input[type="number"] { width: 5.5rem; }
.bench-dash button {
  font: inherit; padding: 0.4rem 0.9rem; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--line); background: var(--surface); color: var(--ink);
}
.bench-dash button.primary { background: var(--bar); border-color: var(--bar); color: #fff; }
.bench-dash button:disabled { opacity: 0.5; cursor: default; }
.bench-dash code { font-size: 13px; }
.bench-dash table { width: 100%; border-collapse: collapse; }
.bench-dash th, .bench-dash td {
  text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--line);
  font-variant-numeric: tabular-nums;
}
.bench-dash th { color: var(--ink-2); font-weight: 500; font-size: 12px; }
.bench-dash .bar-track { min-width: 140px; }
.bench-dash .bar {
  height: 12px; background: var(--bar);
  border-radius: 0 4px 4px 0;
}
.bench-dash .chip { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; }
.bench-dash .chip::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.bench-dash .chip.ok { color: var(--good); }
.bench-dash .chip.fail { color: var(--bad); }
.bench-dash .seg-track { display: flex; height: 12px; margin-top: 4px; }
.bench-dash .seg { height: 12px; }
.bench-dash .seg + .seg { margin-left: 2px; }
.bench-dash .legend { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 4px; color: var(--ink-2); font-size: 12px; }
.bench-dash .legend .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
.bench-dash .hint { color: var(--ink-3); font-size: 12px; }
`;

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx]!;
}

function withFlight(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}_rsc_partial=true&_rsc_segments=`;
}

async function fetchSample(
  path: string,
  expects: RouteClass["expects"],
  flight: boolean,
): Promise<Sample> {
  const target = flight ? withFlight(path) : path;
  const headers: Record<string, string> = flight
    ? { "X-RSC-Router-Client-Path": "/" }
    : { accept: expects === "json" ? "application/json" : "text/html" };

  const absolute = new URL(target, window.location.origin).href;
  const start = performance.now();
  const res = await fetch(target, { headers });
  const body = await res.arrayBuffer();
  const ms = performance.now() - start;

  const entries = performance.getEntriesByName(
    absolute,
  ) as PerformanceResourceTiming[];
  const entry = entries[entries.length - 1];
  const ttfbMs =
    entry && entry.requestStart > 0
      ? entry.responseStart - entry.requestStart
      : null;

  return {
    ms,
    ttfbMs,
    status: res.status,
    bytes: body.byteLength,
    serverTiming: parseServerTiming(res.headers.get("server-timing")),
  };
}

function summarize(
  cls: RouteClass,
  path: string,
  mode: ResultRow["mode"],
  flight: boolean,
  samples: Sample[],
): ResultRow {
  const times = samples.map((s) => s.ms).sort((a, b) => a - b);
  const ttfbs = samples
    .map((s) => s.ttfbMs)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  const expectedStatus = cls.expects === "miss" ? 404 : 200;
  const timingKeys = new Set<string>();
  for (const s of samples)
    for (const k of Object.keys(s.serverTiming)) timingKeys.add(k);
  const serverTiming: Record<string, number> = {};
  for (const k of timingKeys) {
    const vals = samples
      .map((s) => s.serverTiming[k] ?? 0)
      .sort((a, b) => a - b);
    serverTiming[k] = quantile(vals, 0.5);
  }
  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    classId: cls.id,
    label: cls.label,
    path,
    mode,
    flight,
    n: samples.length,
    ok: samples.every((s) => s.status === expectedStatus),
    medianMs: quantile(times, 0.5),
    p90Ms: quantile(times, 0.9),
    minMs: times[0] ?? 0,
    maxMs: times[times.length - 1] ?? 0,
    ttfbMedianMs: ttfbs.length ? quantile(ttfbs, 0.5) : null,
    bytes: samples[samples.length - 1]?.bytes ?? 0,
    status: samples[samples.length - 1]?.status ?? 0,
    serverTiming,
  };
}

function loadStoredResults(): ResultRow[] {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function storeResults(rows: ResultRow[]) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(rows.slice(0, 60)));
  } catch {
    // Ignore quota errors — results are ephemeral diagnostics.
  }
}

function ServerTimingBar({ timings }: { timings: Record<string, number> }) {
  const known = TIMING_SEGMENTS.map((seg) => ({
    ...seg,
    value: timings[seg.key] ?? 0,
  }));
  const knownTotal = known.reduce((sum, seg) => sum + seg.value, 0);
  const total = Math.max(timings["total-request"] ?? 0, knownTotal);
  if (total <= 0) return <span className="hint">no Server-Timing data</span>;
  const rest = Math.max(0, total - knownTotal);
  const segments = [
    ...known.filter((seg) => seg.value > 0),
    ...(rest > 0.05 * total
      ? [{ key: "rest", label: "other", varName: "--seg-rest", value: rest }]
      : []),
  ];
  return (
    <div>
      <div
        className="seg-track"
        role="img"
        aria-label={`Server timing, total ${total.toFixed(1)} ms`}
      >
        {segments.map((seg) => (
          <div
            key={seg.key}
            className="seg"
            style={{
              width: `${Math.max(1, (seg.value / total) * 100)}%`,
              background: `var(${seg.varName})`,
            }}
            title={`${seg.label}: ${seg.value.toFixed(1)} ms`}
          />
        ))}
      </div>
      <div className="legend">
        {segments.map((seg) => (
          <span key={seg.key}>
            <span
              className="swatch"
              style={{ background: `var(${seg.varName})` }}
            />
            {seg.label} {seg.value.toFixed(1)}ms
          </span>
        ))}
      </div>
    </div>
  );
}

function NavTimingTile() {
  const [nav, setNav] = useState<PerformanceNavigationTiming | null>(null);
  useEffect(() => {
    const entries = performance.getEntriesByType(
      "navigation",
    ) as PerformanceNavigationTiming[];
    setNav(entries[0] ?? null);
  }, []);
  if (!nav) return null;
  const ttfb = nav.responseStart - nav.startTime;
  const dcl = nav.domContentLoadedEventEnd - nav.startTime;
  return (
    <p className="hint" data-testid="dash-nav-timing">
      This page's own document load: TTFB {ttfb.toFixed(0)}ms, DOMContentLoaded{" "}
      {dcl.toFixed(0)}ms. Open a route as a document (link below) and check its
      dashboard again to compare — full reloads can't be looped from script
      honestly, so document mode is one-shot by design.
    </p>
  );
}

export function BenchDashboard() {
  const router = useRouter();
  const [classId, setClassId] = useState(routeClasses[0]!.id);
  const [values, setValues] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<"fetch" | "nav" | "document">("fetch");
  const [flight, setFlight] = useState(false);
  const [prefetchFirst, setPrefetchFirst] = useState(false);
  const [n, setN] = useState(10);
  const [busy, setBusy] = useState<string | null>(null);
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    performance.setResourceTimingBufferSize?.(4096);
    setRows(loadStoredResults());
    // Island-local hydration marker for e2e. The router's data-hydrated
    // signal (html attribute) is NOT sufficient here: it is stamped by the
    // root tree's effect, while this component is a lazily-loaded client
    // island whose chunk can still be fetching in dev — clicks between the
    // two land on dead SSR DOM (observed as a flaky dev e2e).
    setReady(true);
  }, []);

  const cls = useMemo(
    () => routeClasses.find((c) => c.id === classId)!,
    [classId],
  );
  const effectiveValues = useMemo(() => {
    const v: Record<string, string> = {};
    for (const input of cls.inputs) {
      v[input.name] = values[`${cls.id}:${input.name}`] ?? input.defaultValue;
    }
    return v;
  }, [cls, values]);
  const path = cls.build(effectiveValues);

  const groups = useMemo(() => {
    const byGroup = new Map<string, RouteClass[]>();
    for (const c of routeClasses) {
      byGroup.set(c.group, [...(byGroup.get(c.group) ?? []), c]);
    }
    return [...byGroup.entries()];
  }, []);

  const addRow = (row: ResultRow) => {
    setRows((prev) => {
      const next = [row, ...prev];
      storeResults(next);
      return next;
    });
  };

  const runFetch = async (
    target: RouteClass,
    targetPath: string,
    count: number,
  ) => {
    setBusy(`${target.label} ×${count}`);
    // Bounded buffer: without clearing, a long session marches to the 4096
    // entry cap, TTFB silently becomes null, and every sample scans the full
    // buffer.
    performance.clearResourceTimings();
    try {
      const samples: Sample[] = [];
      for (let i = 0; i < count; i++) {
        samples.push(await fetchSample(targetPath, target.expects, flight));
      }
      addRow(summarize(target, targetPath, "fetch", flight, samples));
    } finally {
      setBusy(null);
    }
  };

  const runClientNav = async () => {
    setBusy("navigating…");
    if (prefetchFirst) {
      router.prefetch(path);
      await new Promise((r) => setTimeout(r, 400));
    }
    const start = performance.now();
    // The dashboard unmounts during navigation; persist from the closure,
    // then return. Remount re-reads sessionStorage.
    try {
      await router.push(path);
      const ms = performance.now() - start;
      const stored = loadStoredResults();
      const sample: Sample = {
        ms,
        ttfbMs: null,
        status: 200,
        bytes: 0,
        serverTiming: {},
      };
      storeResults([
        summarize(cls, path, prefetchFirst ? "nav+prefetch" : "nav", false, [
          sample,
        ]),
        ...stored,
      ]);
    } finally {
      router.back();
    }
  };

  const runCompareAll = async () => {
    setBusy("comparing all classes…");
    performance.clearResourceTimings();
    try {
      for (const c of routeClasses) {
        const v: Record<string, string> = {};
        for (const input of c.inputs) v[input.name] = input.defaultValue;
        const p = c.build(v);
        const samples: Sample[] = [];
        for (let i = 0; i < Math.min(n, 10); i++) {
          samples.push(await fetchSample(p, c.expects, false));
        }
        addRow(summarize(c, p, "fetch", false, samples));
      }
    } finally {
      setBusy(null);
    }
  };

  const maxMedian = Math.max(1, ...rows.map((r) => r.medianMs));

  return (
    <div className="bench-dash">
      <style>{CSS}</style>
      {ready && <span data-testid="dash-ready" hidden />}
      <h1>Benchmark dashboard</h1>
      <p className="sub">
        Host:{" "}
        <code>{typeof location !== "undefined" ? location.host : ""}</code> —
        timings are client-observed; Server-Timing rows are the worker's own
        breakdown. matchStats needs the <code>MATCH_DEBUG=1</code> binding and
        stays zero for trie hits (see BENCHMARK.md).
      </p>

      <div className="card">
        <div className="controls">
          <div>
            <label htmlFor="dash-class">Route class</label>
            <select
              id="dash-class"
              data-testid="dash-class"
              value={classId}
              onChange={(e) => setClassId(e.target.value)}
            >
              {groups.map(([group, classes]) => (
                <optgroup key={group} label={group}>
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          {cls.inputs.map((input) => {
            const writeInput = (value: string) =>
              setValues((v) => ({
                ...v,
                [`${cls.id}:${input.name}`]: value,
              }));
            return (
              <div key={input.name}>
                <label htmlFor={`dash-in-${input.name}`}>{input.label}</label>
                {input.kind === "locale" ? (
                  <select
                    id={`dash-in-${input.name}`}
                    value={effectiveValues[input.name]}
                    onChange={(e) => writeInput(e.target.value)}
                  >
                    {LOCALES.map((l) => (
                      <option key={l}>{l}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={`dash-in-${input.name}`}
                    type={input.kind === "number" ? "number" : "text"}
                    min={1}
                    max={input.max}
                    value={effectiveValues[input.name]}
                    onChange={(e) => writeInput(e.target.value)}
                  />
                )}
              </div>
            );
          })}

          <div>
            <label htmlFor="dash-mode">Mode</label>
            <select
              id="dash-mode"
              data-testid="dash-mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as typeof mode)}
            >
              <option value="fetch">fetch (N runs)</option>
              <option value="nav">client navigation</option>
              <option value="document">document load</option>
            </select>
          </div>

          {mode === "fetch" && (
            <>
              <div>
                <label htmlFor="dash-n">Runs</label>
                <select
                  id="dash-n"
                  data-testid="dash-n"
                  value={n}
                  onChange={(e) => setN(Number(e.target.value))}
                >
                  {[1, 5, 10, 25, 50].map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
              <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={flight}
                  onChange={(e) => setFlight(e.target.checked)}
                />
                Flight (client-nav payload)
              </label>
              <button
                className="primary"
                data-testid="dash-run"
                disabled={busy !== null}
                onClick={() => void runFetch(cls, path, n)}
              >
                Run {n}×
              </button>
            </>
          )}

          {mode === "nav" && (
            <>
              <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={prefetchFirst}
                  onChange={(e) => setPrefetchFirst(e.target.checked)}
                />
                prefetch first
              </label>
              <button
                className="primary"
                disabled={busy !== null}
                onClick={() => void runClientNav()}
              >
                Navigate + measure
              </button>
            </>
          )}

          {mode === "document" && (
            <a href={path} data-testid="dash-doc-link">
              Open <code>{path}</code> as a document →
            </a>
          )}
        </div>

        <p className="hint" style={{ marginBottom: 0 }}>
          Target: <code data-testid="dash-path">{path}</code>
          {cls.note ? ` — ${cls.note}` : ""}
          {busy ? ` — running: ${busy}` : ""}
        </p>
        {mode === "document" && <NavTimingTile />}
      </div>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <strong>Results</strong>
          <span>
            <button
              data-testid="dash-compare"
              disabled={busy !== null}
              onClick={() => void runCompareAll()}
              style={{ marginRight: 8 }}
            >
              Run all classes ({Math.min(n, 10)}× each)
            </button>
            <button
              disabled={rows.length === 0}
              onClick={() => {
                setRows([]);
                storeResults([]);
              }}
            >
              Clear
            </button>
          </span>
        </div>

        {rows.length === 0 ? (
          <p className="hint">No runs yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Class</th>
                <th>Mode</th>
                <th>n</th>
                <th>median</th>
                <th className="bar-track" aria-hidden="true"></th>
                <th>p90</th>
                <th>min–max</th>
                <th>TTFB</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <RowView key={r.key} row={r} maxMedian={maxMedian} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function RowView({ row, maxMedian }: { row: ResultRow; maxMedian: number }) {
  const [open, setOpen] = useState(false);
  const hasTimings = Object.keys(row.serverTiming).length > 0;
  return (
    <>
      <tr data-testid="dash-result-row">
        <td>
          <div>{row.label}</div>
          <code className="hint">{row.path}</code>
        </td>
        <td>
          {row.mode}
          {row.flight ? " +flight" : ""}
        </td>
        <td>{row.n}</td>
        <td data-testid="dash-median">{row.medianMs.toFixed(1)}ms</td>
        <td className="bar-track">
          <div
            className="bar"
            style={{ width: `${(row.medianMs / maxMedian) * 100}%` }}
            title={`${row.label}: median ${row.medianMs.toFixed(1)} ms`}
          />
        </td>
        <td>{row.p90Ms.toFixed(1)}ms</td>
        <td>
          {row.minMs.toFixed(1)}–{row.maxMs.toFixed(1)}ms
        </td>
        <td>
          {row.ttfbMedianMs != null ? `${row.ttfbMedianMs.toFixed(1)}ms` : "–"}
        </td>
        <td>
          <span className={`chip ${row.ok ? "ok" : "fail"}`}>
            {row.ok ? `${row.status} ok` : `${row.status} unexpected`}
          </span>
          {hasTimings && (
            <button
              style={{ marginLeft: 8, fontSize: 12, padding: "0.1rem 0.4rem" }}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? "hide" : "server"}
            </button>
          )}
        </td>
      </tr>
      {open && hasTimings && (
        <tr>
          <td colSpan={9}>
            <ServerTimingBar timings={row.serverTiming} />
          </td>
        </tr>
      )}
    </>
  );
}
