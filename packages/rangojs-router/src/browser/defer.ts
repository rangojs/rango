import { use } from "react";
import { SETTLED_THENABLE } from "../thenable-status.js";

/**
 * One hole of a `prefetch: false` adoption (browser/partial-update.ts
 * armHoles): the promise every reader of the hole waits on, and what the
 * router knows of it. The router sets `status` and `value` here; it never
 * writes React's thenable fields on `promise`.
 *
 * Resolve-only: a hole is filled or released (releaseHoles), never rejected.
 * A failure arrives as a fulfilled value (a loader's error envelope, an
 * error segment's node).
 */
export class Defer<T> {
  status: "pending" | "fulfilled" = "pending";
  value: T | undefined;
  /** A reader has handed React `promise` (readDefer). */
  read?: boolean;
  /**
   * Resolved with a value the router holds (a node), the hole is
   * "fulfilled" at once. Resolved with a stream (a Flight chunk), its promise
   * follows the stream and it stays "pending": readers wait on the promise.
   */
  resolve!: (value: T) => void;
  readonly promise: Promise<T> = new Promise<T>((settle) => {
    this.resolve = (value) => {
      settle(value);
      if (!(value instanceof Promise)) {
        this.status = "fulfilled";
        this.value = value;
      }
    };
  });
}

/**
 * The read rule, for a component that reads a hole (Suspender, useLoader).
 * A hole that has fulfilled and that no reader has handed React is its
 * value: use() of a promise React has not seen suspends an urgent render
 * once, and the boundary shows its fallback. Once a reader has handed React
 * the promise, every read is use() of that promise: React has marked it and
 * returns its value at once, and a replay of the reader must hand use() the
 * thenable it read before ("A component was suspended by an uncached
 * promise"). Either way use() is called once, as at every useLoader read.
 */
export function readDefer<T>(hole: Defer<T>): T {
  if (hole.status === "fulfilled" && !hole.read) {
    use(SETTLED_THENABLE);
    return hole.value as T;
  }
  hole.read = true;
  return use(hole.promise);
}

/**
 * A hole as the loader-streams convention has it: its promise while pending,
 * its value once fulfilled. Anything else is returned as it is. For an
 * aggregate, the pending-stream registry, and a node React reads itself (a
 * segment or slot with no `loading()`): a router component there would be a
 * fiber the filled page's node does not have, and the next render from the
 * filled entry would remount the segment. React suspends such a read on the
 * component above it, which commits nothing until the hole fulfils, so the
 * value can stand where React read the promise.
 */
export function asStream(value: unknown): unknown {
  return value instanceof Defer
    ? value.status === "fulfilled"
      ? value.value
      : value.promise
    : value;
}
