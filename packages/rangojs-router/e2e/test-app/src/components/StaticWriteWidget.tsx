"use client";

import { useEffect, useState } from "react";
import { useLocationState } from "@rangojs/router/client";
import {
  StaticWriteDemo,
  type StaticWriteDemoState,
} from "../location-states.js";

/**
 * Exercises LocationState.write() / .delete() / .read() against a real
 * history entry. Two display surfaces:
 *
 *  - "static": value re-read from history.state via .read() on demand.
 *    Proves write/delete actually mutate history.state and that values
 *    survive back/forward + hard refresh.
 *  - "reactive": value from useLocationState(). Proves write() does NOT
 *    fire __rsc_locationstate or popstate, so subscribers do not update
 *    until the next navigation. (Regression guard for flash semantics.)
 *
 * Hydration safety: the static surface renders `undefined` on the first
 * client render so the output matches the server (which has no access to
 * history.state). The reactive surface relies on useLocationState() to do the
 * same initial hydration-safe read and sync post-mount.
 */
export function StaticWriteWidget() {
  const [snapshot, setSnapshot] = useState<StaticWriteDemoState | undefined>(
    undefined,
  );
  const reactive = useLocationState(StaticWriteDemo);

  useEffect(() => {
    setSnapshot(StaticWriteDemo.read());
  }, []);

  const refresh = () => setSnapshot(StaticWriteDemo.read());

  return (
    <div data-testid="static-write-widget">
      <button
        type="button"
        data-testid="sw-write-a"
        onClick={() => {
          StaticWriteDemo.write({ label: "alpha", count: 1 });
          refresh();
        }}
      >
        Write A
      </button>
      <button
        type="button"
        data-testid="sw-write-b"
        onClick={() => {
          StaticWriteDemo.write({ label: "beta", count: 2 });
          refresh();
        }}
      >
        Write B
      </button>
      <button
        type="button"
        data-testid="sw-delete"
        onClick={() => {
          StaticWriteDemo.delete();
          refresh();
        }}
      >
        Delete
      </button>
      <button type="button" data-testid="sw-refresh" onClick={refresh}>
        Refresh display
      </button>

      <div data-testid="sw-static">
        {snapshot ? (
          <span data-testid="sw-static-value">
            {snapshot.label}:{snapshot.count}
          </span>
        ) : (
          <span data-testid="sw-static-empty">empty</span>
        )}
      </div>

      <div data-testid="sw-reactive">
        {reactive ? (
          <span data-testid="sw-reactive-value">
            {reactive.label}:{reactive.count}
          </span>
        ) : (
          <span data-testid="sw-reactive-empty">empty</span>
        )}
      </div>
    </div>
  );
}
