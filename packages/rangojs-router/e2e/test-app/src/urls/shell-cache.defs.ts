import { createLoader, createHandle } from "@rangojs/router";

// Live hole under the frozen PPR shell (docs/design/ppr-shell-resume.md). ~400ms
// so the shell prelude clearly beats the hole; seq advances on every request to
// prove loaders stay fresh while the shell is served from the cached prelude.
// Directive-free so the client price component can import it by identity
// (useLoader) without pulling the route factory into the client graph.
const SHELL_LOADER_DELAY_MS = 400;

export interface ShellPriceData {
  price: number;
  seq: number;
  loadedAt: number;
}

let shellPriceSeq = 0;

export const ShellPriceLoader = createLoader(
  async (): Promise<ShellPriceData> => {
    await new Promise((resolve) => setTimeout(resolve, SHELL_LOADER_DELAY_MS));
    shellPriceSeq += 1;
    return { price: 42, seq: shellPriceSeq, loadedAt: Date.now() };
  },
);

// Loader-carried promise: the deterministic streaming lane under a PPR hole
// (docs/design/ppr-shell-resume.md). Resolves its OUTER value fast but carries a
// NESTED promise settling ~300ms later. FlightSerialize preserves the nested
// Promise (src/serialize.ts), so the client use()s it under its OWN inner
// Suspense — a second streaming layer INSIDE the loader hole. One loader backs
// both /shell-cache/stream (WITH loading(): the hole; HIT streams three layers)
// and /shell-cache/no-hole (NO loading(): capture refuses, eternal MISS, but the
// inner promise still streams under axis 1).
const SHELL_STREAM_INNER_DELAY_MS = 300;

export interface ShellStreamData {
  label: string;
  pendingData: Promise<string>;
}

let shellStreamSeq = 0;

export const ShellStreamLoader = createLoader(
  async (): Promise<ShellStreamData> => {
    shellStreamSeq += 1;
    const seq = shellStreamSeq;
    const pendingData = new Promise<string>((resolve) =>
      setTimeout(
        () => resolve(`Streamed inner ${seq}`),
        SHELL_STREAM_INNER_DELAY_MS,
      ),
    );
    return { label: "Streamed outer", pendingData };
  },
);

// Handles contract fixture ("nesting = liveness"). The shell layout pushes TWO
// entries into this handle:
//   1. a TOP-LEVEL promise (the pushed value IS a promise, resolving after a real
//      ~150ms latency) — resolvedHandleStream awaits it before the payload's
//      handles row emits, and the capture gate is HELD open for the same await,
//      so the resolved value is BAKED into the shell prelude;
//   2. a CONTAINER carrying a NESTED promise ({ kind, pending }) — the shallow
//      isThenable resolution passes the container through verbatim, so the nested
//      promise streams to the consumer, who must Suspense it — a HOLE.
// Values are DETERMINISTIC (no seq): baked shell material must not drift between
// the captured prelude and the fresh hydration payload.
export interface ShellHandleItem {
  kind: "baked" | "nested";
  value?: string;
  pending?: Promise<string>;
}

export const ShellHandles = createHandle<ShellHandleItem, ShellHandleItem[]>(
  (values) => values.flat(),
);

const SHELL_HANDLE_BAKED_DELAY_MS = 150;
const SHELL_HANDLE_NESTED_DELAY_MS = 250;

/** Top-level promise push: baked into the shell once resolved. */
export function makeBakedHandlePush(): Promise<ShellHandleItem> {
  return new Promise((resolve) =>
    setTimeout(
      () => resolve({ kind: "baked", value: "TOP-LEVEL-BAKED" }),
      SHELL_HANDLE_BAKED_DELAY_MS,
    ),
  );
}

/** Container push with a nested promise: the nested value stays a hole. */
export function makeNestedHandlePush(): ShellHandleItem {
  return {
    kind: "nested",
    pending: new Promise((resolve) =>
      setTimeout(
        () => resolve("NESTED-HANDLE-STREAMED"),
        SHELL_HANDLE_NESTED_DELAY_MS,
      ),
    ),
  };
}

// Physics fixture: a handler-created promise passed as a PROP to a client
// component that use()s it under its own <Suspense>. Genuinely pending real I/O
// (~250ms) cannot win the capture's task-quantized quiet window, so the boundary
// postpones — a HOLE by physics, not by registration. Deterministic value (no
// drift; the resumed HTML and hydration payload come from the same tail render).
const SHELL_PHYSICS_DELAY_MS = 250;

export function makePhysicsPromise(): Promise<string> {
  return new Promise((resolve) =>
    setTimeout(() => resolve("PHYSICS-HOLE-VALUE"), SHELL_PHYSICS_DELAY_MS),
  );
}
