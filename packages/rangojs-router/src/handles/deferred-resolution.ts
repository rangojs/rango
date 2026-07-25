import type { HandleData, HandleStore } from "../server/handle-store.js";
import { isThenable } from "./is-thenable.js";

/**
 * Runtime-neutral resolution of deferred (Promise) handle values. Shared by the
 * server full-render path (resolve before the payload is finalized so SSR sees
 * resolved values) and the client soft-nav path (NavigationProvider resolves
 * each yield before applying it). Pure — imports only `isThenable` — so it is
 * safe in both the RSC server environment AND the browser.
 *
 * Resolution is SHALLOW: only an entry that is ITSELF a thenable is awaited. A
 * value that merely contains a promise (e.g. `{ data: somePromise }`) is a
 * non-thenable, so the `isThenable` check skips it and it passes through verbatim
 * — the nested promise is the consumer's responsibility. Resolution runs each
 * entry through `Promise.all` with a per-entry `try/catch` (NOT `allSettled`), so
 * one rejecting entry is dropped without rejecting the batch or aborting siblings.
 */

/**
 * Handle names ($$id) whose snapshot carries a deferred (top-level Promise)
 * value. Used by the client to decide which buckets to hold-and-resolve, and
 * `.size > 0` answers "does this snapshot have any deferred value".
 */
export function deferredHandleNames(data: HandleData): Set<string> {
  const names = new Set<string>();
  for (const [handleName, segments] of Object.entries(data)) {
    for (const values of Object.values(segments)) {
      if (values.some(isThenable)) {
        names.add(handleName);
        break;
      }
    }
  }
  return names;
}

/**
 * Snapshot with deferred (Promise) values awaited (shallow — only top-level
 * thenables). A rejected deferred is dropped, and a deferred that resolves to
 * `null`/`undefined` is dropped (the `.defer({ else })` skip semantics), so a
 * nullish deferred slot never reaches a collector. Sync (non-thenable) values —
 * including a legitimate sync `null` push — pass through unchanged.
 */
export async function resolveDeferredHandleValues(
  data: HandleData,
): Promise<HandleData> {
  const out: HandleData = {};
  await Promise.all(
    Object.entries(data).flatMap(([handleName, segments]) => {
      out[handleName] = {};
      return Object.entries(segments).map(async ([segmentId, values]) => {
        out[handleName][segmentId] = await resolveValues(values);
      });
    }),
  );
  return out;
}

// Resolve each entry IN ORDER. A non-thenable passes through verbatim (including
// a legitimate sync `null`/`undefined` push — the "await iff thenable" contract).
// A thenable is awaited and dropped when it rejects OR resolves to null/undefined
// (the `.defer({ else })` skip semantics: a forgotten resolver times out to
// `else ?? undefined`), so a nullish deferred slot never reaches a collector.
async function resolveValues(values: unknown[]): Promise<unknown[]> {
  const resolved = await Promise.all(
    values.map(async (v) => {
      if (!isThenable(v)) return { keep: true, value: v };
      try {
        const value = await v;
        return { keep: value != null, value };
      } catch {
        return { keep: false, value: undefined };
      }
    }),
  );
  return resolved.filter((r) => r.keep).map((r) => r.value);
}

/**
 * Full-render handle stream: a one-shot async generator that yields the FINAL
 * handle snapshot with every top-level deferred value resolved. Drop-in for
 * `handleStore.stream()` on full / HTML renders (initial load, 404, progressive
 * enhancement), where the consumer drains the generator to completion before
 * rendering anyway — so the single final yield is equivalent to the streamed
 * yields' converged state, and the SSR markup plus the first sync `useHandle`
 * read see resolved values. `getData()` seals the store and awaits the handler
 * barrier; `resolveDeferredHandleValues` then awaits the pushed-value promises.
 * A hung handle promise blocks the full render like any unresolved await (no
 * handle-specific timeout). Partial / action payloads keep streaming via
 * `handleStore.stream()`.
 */
export async function* resolvedHandleStream(
  handleStore: HandleStore,
): AsyncGenerator<HandleData, void, unknown> {
  // Drain stream() (NOT getData()) for the converged snapshot: consuming a
  // stream arms the store's late-push guard (LateHandlePushError for pushes
  // after FULL settle — an async JSX subtree that suspended and later calls
  // ctx.use(Handle)(...) after collection). getData() never arms it, so the
  // late push would silently land.
  //
  // Scoped to the HANDLER barrier ("settled"), NOT full settle: both document
  // consumers (ssr-root.tsx React.use, rsc-router.tsx pre-hydration drain)
  // block on this generator's COMPLETION, so waiting for the auxiliary
  // (loader) lane would hold SSR markup and hydration hostage to the slowest
  // streaming loader. Loader pushes that beat the handler barrier are in this
  // snapshot (the race); later ones ride metadata.handlesLate
  // (handleStore.streamLate()), applied client-side post-hydration.
  let snapshot: HandleData = {};
  for await (const data of handleStore.stream("settled")) {
    snapshot = data;
  }
  yield await resolveDeferredHandleValues(snapshot);
}

/**
 * Resolve the deferred (Promise) values in ONE segment's handle bucket
 * (`handleName -> entries[]`). Same shallow + drop-rejections rule as
 * {@link resolveDeferredHandleValues}, but for the segment-keyed shape the
 * prerender/static collection paths use (`getDataForSegment`). Prerender is a
 * build-time cache, so the baked artifact must hold resolved values — a hit
 * replays them into the segment system, where collect/useHandle expect resolved
 * data.
 */
export async function resolveSegmentHandleValues(
  segHandles: Record<string, unknown[]>,
): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  await Promise.all(
    Object.entries(segHandles).map(async ([handleName, values]) => {
      out[handleName] = await resolveValues(values);
    }),
  );
  return out;
}
