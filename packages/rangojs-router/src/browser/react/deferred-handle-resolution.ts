import type { HandleData } from "../types.js";
import { isThenable } from "../../handles/is-thenable.js";

/**
 * The set of handle names whose deferred (Promise) values MUST be resolved in
 * the store BEFORE the snapshot is applied during client navigation.
 *
 * The boundary: a handle belongs here only if its consumer `use()`s a promise in
 * <head>, above the route's <Suspense>. Suspending there would revert the
 * just-committed route and hide its loading fallback. Today that is Meta alone
 * (MetaTags lives in <head> and use()s deferred descriptors). Every OTHER handle
 * keeps the public DeferredHandleEntry contract: its deferred value reaches the
 * consumer AS A PROMISE during soft navigation, narrowed via isThenable().
 *
 * If a future head-placed handle starts use()-ing promises, add its name here.
 */
export const HEAD_RESOLVE_HANDLE_NAMES: readonly string[] = [
  "__rsc_router_meta__",
];

/**
 * True when a handle value in this snapshot is a deferred (Promise) value.
 *
 * When `onlyHandleNames` is given, only those handle buckets are considered;
 * deferred values under any other handle are ignored (they pass through to the
 * consumer as promises, by contract).
 */
export function hasDeferredHandleValue(
  data: HandleData,
  onlyHandleNames?: readonly string[],
): boolean {
  const scope = onlyHandleNames ? new Set(onlyHandleNames) : null;
  for (const [handleName, segments] of Object.entries(data)) {
    if (scope && !scope.has(handleName)) continue;
    for (const values of Object.values(segments)) {
      if (values.some(isThenable)) return true;
    }
  }
  return false;
}

/**
 * Snapshot with deferred (Promise) values awaited; a rejected deferred is
 * dropped (it contributes nothing), mirroring the render-side REJECTED_META.
 * Promise.allSettled treats non-promise values as already-fulfilled, so plain
 * values pass through unchanged.
 *
 * When `onlyHandleNames` is given, ONLY those handle buckets are resolved; every
 * other bucket is copied through by reference (its deferred values keep their
 * promise identity so the consumer can narrow them).
 */
export async function resolveDeferredHandleValues(
  data: HandleData,
  onlyHandleNames?: readonly string[],
): Promise<HandleData> {
  const scope = onlyHandleNames ? new Set(onlyHandleNames) : null;
  const out: HandleData = {};
  await Promise.all(
    Object.entries(data).flatMap(([handleName, segments]) => {
      // Out-of-scope buckets pass through untouched (promise identity kept).
      if (scope && !scope.has(handleName)) {
        out[handleName] = segments;
        return [];
      }
      out[handleName] = {};
      return Object.entries(segments).map(async ([segmentId, values]) => {
        const settled = await Promise.allSettled(values);
        out[handleName][segmentId] = settled
          .filter((r) => r.status === "fulfilled")
          .map((r) => (r as PromiseFulfilledResult<unknown>).value);
      });
    }),
  );
  return out;
}
