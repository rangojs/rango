"use client";

import { useEffect, useState } from "react";

/**
 * Live view of the /prefetch-false fixture's server run counters
 * (prefetch-false-counts.ts) for one `?run=`, for trying the fixture by hand.
 * Rendered only under `?manual=1`: a suite's page makes no polling requests.
 */
export function PrefetchFalseCounts({
  run,
  tall = false,
}: {
  run: string;
  tall?: boolean;
}) {
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    let live = true;
    const read = async () => {
      try {
        const res = await fetch(
          `/prefetch-false/__counts?run=${encodeURIComponent(run)}`,
          { cache: "no-store" },
        );
        const next: Record<string, number> = await res.json();
        if (!live) return;
        setCounts((prev) =>
          JSON.stringify(prev) === JSON.stringify(next) ? prev : next,
        );
      } catch {
        // The dev server is restarting; the next tick reads again.
      }
    };
    void read();
    const id = setInterval(read, 400);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [run]);

  const names = Object.keys(counts).sort();
  return (
    <aside
      data-testid="pf-counts"
      style={{
        padding: 12,
        border: "1px solid rgba(128,128,128,0.5)",
        borderRadius: 6,
        fontSize: 14,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <strong>What the server ran</strong>
        <span style={{ opacity: 0.6 }}>run "{run || "(none)"}"</span>
      </div>
      {names.length === 0 ? (
        <p style={{ margin: "8px 0", opacity: 0.7 }}>
          Nothing yet. Hover a link.
        </p>
      ) : (
        <table style={{ width: "100%", margin: "8px 0", borderSpacing: 0 }}>
          <tbody>
            {names.map((name) => (
              <tr key={name}>
                <td style={{ fontFamily: "ui-monospace, monospace" }}>
                  {name}
                </td>
                <td style={{ textAlign: "right" }}>
                  {counts[name]} {counts[name] === 1 ? "run" : "runs"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button
        type="button"
        onClick={() =>
          window.location.assign(
            `/prefetch-false?run=${Date.now().toString(36)}&manual=1${tall ? "&tall=1" : ""}`,
          )
        }
      >
        Start a new run
      </button>{" "}
      <button
        type="button"
        onClick={() =>
          window.location.assign(
            `/prefetch-false?run=${encodeURIComponent(run)}&manual=1${tall ? "" : "&tall=1"}`,
          )
        }
      >
        {tall ? "Normal page" : "Tall page (scroll test)"}
      </button>
    </aside>
  );
}

/** Fixed badge with the live `window.scrollY`, for the scroll test. */
export function PrefetchFalseScroll() {
  const [y, setY] = useState(0);
  useEffect(() => {
    const read = () => setY(Math.round(window.scrollY));
    read();
    window.addEventListener("scroll", read, { passive: true });
    return () => window.removeEventListener("scroll", read);
  }, []);
  return (
    <div
      data-testid="pf-scroll-y"
      style={{
        position: "fixed",
        left: 12,
        bottom: 12,
        padding: "6px 12px",
        borderRadius: 6,
        background: "#111",
        color: "#fff",
        border: "1px solid #888",
        fontFamily: "ui-monospace, monospace",
        zIndex: 1000,
      }}
    >
      scrollY: {y}
    </div>
  );
}
