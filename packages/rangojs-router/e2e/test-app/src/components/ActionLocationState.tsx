"use client";

import { useState } from "react";
import { Link, useLocationState } from "@rangojs/router/client";
import { ActionInfoA, ActionInfoB } from "../location-states.js";
import { setLocationStateSlot, setSlotWithMarker } from "../actions.js";

export function ActionInfoDisplay() {
  const a = useLocationState(ActionInfoA);
  const b = useLocationState(ActionInfoB);
  return (
    <div data-testid="action-info">
      {a ? (
        <p data-testid="action-info-a-data">{a.value}</p>
      ) : (
        <p data-testid="action-info-a-empty">No A</p>
      )}
      {b ? (
        <p data-testid="action-info-b-data">{b.value}</p>
      ) : (
        <p data-testid="action-info-b-empty">No B</p>
      )}
    </div>
  );
}

export function ActionLocationStateControls() {
  // Records which dispatched actions have SETTLED (promise resolved) so e2e can
  // wait for a deterministic "both settled" signal instead of a fixed sleep.
  // Reset per burst. Only valid while the component stays mounted (the
  // same-entry tests do not navigate); the cross-entry test uses a slot marker
  // instead because the component remounts across back/forward.
  const [settled, setSettled] = useState<string[]>([]);
  const reset = () => setSettled([]);
  const mark = (id: string) =>
    setSettled((s) => (s.includes(id) ? s : [...s, id].sort()));

  return (
    <div>
      <div data-testid="settled-markers">{settled.join(",") || "none"}</div>

      {/* Single action -> the bridge "normal" terminal. */}
      <button
        data-testid="action-setls-single-btn"
        onClick={() => setLocationStateSlot("A", "A-single", 100)}
      >
        Set A (single)
      </button>

      {/* Concurrent, distinct keys. A (longer delay) settles last via
          consolidation-needed; B settles first via concurrent-skip. Both fire
          in one onClick so they are genuinely in flight together. */}
      <button
        data-testid="action-setls-distinct-btn"
        onClick={() => {
          reset();
          setLocationStateSlot("A", "A-from-action", 600).then(() => mark("a"));
          setLocationStateSlot("B", "B-from-action", 100).then(() => mark("b"));
        }}
      >
        Set A and B (concurrent, distinct)
      </button>

      {/* Same key, first-initiated SLOW (settles last). last-initiated must
          still win -> proves dispatch-order over settle-order. */}
      <button
        data-testid="action-setls-samekey-slowfirst-btn"
        onClick={() => {
          reset();
          setLocationStateSlot("A", "first-initiated", 600).then(() =>
            mark("first"),
          );
          setLocationStateSlot("A", "second-initiated", 100).then(() =>
            mark("second"),
          );
        }}
      >
        Same key (slow first)
      </button>

      {/* Same key, first-initiated FAST (settles first). Other settlement
          order; last-initiated still wins. */}
      <button
        data-testid="action-setls-samekey-fastfirst-btn"
        onClick={() => {
          reset();
          setLocationStateSlot("A", "first-initiated", 100).then(() =>
            mark("first"),
          );
          setLocationStateSlot("A", "second-initiated", 600).then(() =>
            mark("second"),
          );
        }}
      >
        Same key (fast first)
      </button>

      {/* Cross-entry arbitration (P1). Dispatches a SLOW action on THIS entry
          that sets slot A + a distinct marker in slot B. The e2e navigates to a
          new entry, runs a fast action on slot A there, returns here, and this
          slow action must still land its slot A value (cohort-scoped). */}
      <button
        data-testid="action-cross-slow-btn"
        onClick={() => setSlotWithMarker("from-entry-1", "a1-done", 4000)}
      >
        Cross-entry slow (this entry)
      </button>

      {/* Fast action used on the SECOND entry, writing the same slot A. */}
      <button
        data-testid="action-cross-fast-btn"
        onClick={() => setLocationStateSlot("A", "from-entry-2", 100)}
      >
        Cross-entry fast (other entry)
      </button>

      <Link
        to="/location-state/action-ls?e=2"
        data-testid="action-ls-newentry-link"
      >
        New entry
      </Link>
    </div>
  );
}
