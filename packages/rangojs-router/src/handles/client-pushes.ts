import type { HandleData } from "../server/handle-store.js";

/**
 * The client handle layer (usePushHandle): handle id -> segment id -> pusher
 * -> the values that pusher's last committed render pushed. Pushers keep the
 * order they first committed in (Map insertion order).
 */
export type ClientPushes = Map<string, Map<string, Map<object, unknown[]>>>;

/**
 * Structural equality for pushed values: arrays and plain objects by their
 * entries, React elements by type, key and props, dates by time, anything
 * else (a function, a class instance, a null-prototype object) by Object.is. A component that pushes a fresh literal on each render (nested
 * objects included) and reads the same handle would otherwise re-render
 * itself without end: each render's push would look new. `depth` bounds a
 * cyclic value; past it two values count as different.
 */
export function samePushValue(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date)
    return b instanceof Date && a.getTime() === b.getTime();
  const proto = a && typeof a === "object" && Object.getPrototypeOf(a);
  if (
    depth > 32 ||
    !proto ||
    !b ||
    typeof b !== "object" ||
    proto !== Object.getPrototypeOf(b) ||
    (proto !== Object.prototype && proto !== Array.prototype)
  ) {
    return false;
  }
  // A React element's dev-only `_owner` is a fiber: compare what renders.
  const element = "$$typeof" in a;
  const keys = element ? ["$$typeof", "type", "key", "props"] : Object.keys(a);
  return (
    (element || keys.length === Object.keys(b).length) &&
    keys.every(
      (key) =>
        key in b &&
        samePushValue(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
          depth + 1,
        ),
    )
  );
}

/**
 * `data` (the server's handle data) with `handleId`'s client pushes after the
 * server's values in each segment: `[...server, ...pusher1, ...pusher2]`. A
 * fixed position, so what arrives first never decides what shows. A segment
 * only the client pushes into is collected in segment order like any other;
 * one outside the order is skipped by collectHandleData.
 */
export function withClientPushes(
  data: HandleData,
  handleId: string,
  pushes: ClientPushes,
): HandleData {
  const bySegment = pushes.get(handleId);
  if (!bySegment) return data;
  const merged: Record<string, unknown[]> = { ...data[handleId] };
  for (const [segmentId, owners] of bySegment) {
    merged[segmentId] = [
      ...(merged[segmentId] ?? []),
      ...[...owners.values()].flat(),
    ];
  }
  return { ...data, [handleId]: merged };
}
