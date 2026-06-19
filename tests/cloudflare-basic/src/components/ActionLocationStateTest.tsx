"use client";

import { useState, useTransition } from "react";
import { useLocationState } from "@rangojs/router/client";
import {
  ActionFlash,
  ConcurrentSlotA,
  ConcurrentSlotB,
} from "../location-states.js";
import {
  setConcurrentSlot,
  setLocationStateAction,
} from "../actions/action-location-state.js";

export function ActionLocationStateTest() {
  const flash = useLocationState(ActionFlash);
  const [isPending, startTransition] = useTransition();

  return (
    <div data-testid="action-location-state-test">
      <div data-testid="flash-message">{flash?.message ?? "none"}</div>
      {isPending && <div data-testid="pending">pending</div>}

      <button
        data-testid="set-location-state-btn"
        onClick={() =>
          startTransition(async () => {
            await setLocationStateAction();
          })
        }
      >
        Set Location State
      </button>

      <ConcurrentLocationState />
    </div>
  );
}

function ConcurrentLocationState() {
  const a = useLocationState(ConcurrentSlotA);
  const b = useLocationState(ConcurrentSlotB);

  // Deterministic "both settled" signal so e2e never races ahead of the
  // later-settling action. Reset per burst.
  const [settled, setSettled] = useState<string[]>([]);
  const reset = () => setSettled([]);
  const mark = (id: string) =>
    setSettled((s) => (s.includes(id) ? s : [...s, id].sort()));

  return (
    <div data-testid="concurrent-ls">
      <div data-testid="concurrent-a">{a?.value ?? "none"}</div>
      <div data-testid="concurrent-b">{b?.value ?? "none"}</div>
      <div data-testid="concurrent-settled">{settled.join(",") || "none"}</div>

      {/* Distinct keys; A (longer delay) settles last, B first. Both survive. */}
      <button
        data-testid="concurrent-distinct-btn"
        onClick={() => {
          reset();
          setConcurrentSlot("A", "A-from-action", 600).then(() => mark("a"));
          setConcurrentSlot("B", "B-from-action", 100).then(() => mark("b"));
        }}
      >
        Concurrent distinct
      </button>

      {/* Same key, first-initiated SLOW (settles last) -> last-initiated wins. */}
      <button
        data-testid="concurrent-samekey-slowfirst-btn"
        onClick={() => {
          reset();
          setConcurrentSlot("A", "first-initiated", 600).then(() =>
            mark("first"),
          );
          setConcurrentSlot("A", "second-initiated", 100).then(() =>
            mark("second"),
          );
        }}
      >
        Concurrent same key (slow first)
      </button>

      {/* Same key, first-initiated FAST (settles first) -> last-initiated wins. */}
      <button
        data-testid="concurrent-samekey-fastfirst-btn"
        onClick={() => {
          reset();
          setConcurrentSlot("A", "first-initiated", 100).then(() =>
            mark("first"),
          );
          setConcurrentSlot("A", "second-initiated", 600).then(() =>
            mark("second"),
          );
        }}
      >
        Concurrent same key (fast first)
      </button>
    </div>
  );
}
