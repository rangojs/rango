"use client";

import { useLayoutEffect, useState } from "react";
import { useAction } from "@rangojs/router/client";
import { addToCartLatest } from "../actions/action-latest-call.js";

declare global {
  interface Window {
    /** Every commit of ActionLatestCall: what it shows, and pending. */
    __actionLatestLog?: { shown: string; pending: boolean }[];
  }
}

/** Calls of addToCartLatest: the slow one, then the fast one. */
const SLOW = { name: "first", delay: 2000 };
const FAST = { name: "second", delay: 400 };

/**
 * An AddToCart reader of one action called twice: through the full state
 * (`state === "idle" ? result?.name : "Adding…"`) and through a selector.
 * The caller side lists the calls in the order they returned.
 */
export function ActionLatestCall(): React.ReactNode {
  const { state, result } = useAction(addToCartLatest);
  const pending = useAction(addToCartLatest, (s) => s.state !== "idle");
  const [returned, setReturned] = useState<string[]>([]);

  const shown =
    state === "idle"
      ? ((result as { name: string } | null)?.name ?? "")
      : "Adding…";

  useLayoutEffect(() => {
    (window.__actionLatestLog ??= []).push({ shown, pending });
  });

  const add = (call: { name: string; delay: number }) => {
    void addToCartLatest(call.name, call.delay).then((r) =>
      setReturned((all) => [...all, r.name]),
    );
  };

  return (
    <div>
      <p data-testid="action-latest-shown">{shown}</p>
      <button
        type="button"
        data-testid="action-latest-slow"
        onClick={() => add(SLOW)}
      >
        add (slow)
      </button>
      <button
        type="button"
        data-testid="action-latest-fast"
        onClick={() => add(FAST)}
      >
        add (fast)
      </button>
      <p data-testid="action-latest-returned">{returned.join(",")}</p>
    </div>
  );
}
