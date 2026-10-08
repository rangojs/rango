import type { ReactNode } from "react";

/**
 * #1078 candidate "a" (src/vt-experiment.ts). Not for merge.
 *
 * A route's client component arrives as a Flight lazy whose module chunk can
 * still be loading when the navigation commits on the response's first chunk.
 * The loading() boundary then suspends on the module first; when it loads,
 * React retries the boundary, the retry suspends again on the loader stream
 * (use-loader.tsx), and React commits that retry with the fallback still in
 * place. Waiting for the module here leaves the loader stream as the
 * boundary's only wakeable.
 */
const REACT_LAZY: symbol = Symbol.for("react.lazy");
const CAP_MS = 50;
const MAX_NODES = 200;

type Chunk = PromiseLike<unknown> & { status?: string; value?: unknown };

function isUnsettled(chunk: Chunk | undefined): boolean {
  return (
    chunk != null &&
    typeof chunk.then === "function" &&
    (chunk.status === "pending" || chunk.status === "blocked")
  );
}

function collectPending(
  node: unknown,
  out: Chunk[],
  budget: { left: number },
): void {
  if (node == null || typeof node !== "object" || budget.left-- <= 0) return;
  if (Array.isArray(node)) {
    for (const child of node) collectPending(child, out, budget);
    return;
  }
  const el = node as {
    $$typeof?: symbol;
    _payload?: Chunk;
    type?: unknown;
    props?: { children?: unknown };
  };
  if (el.$$typeof === REACT_LAZY) {
    const payload = el._payload;
    if (payload && isUnsettled(payload)) out.push(payload);
    else if (payload?.status === "fulfilled") {
      collectPending(payload.value, out, budget);
    }
    return;
  }
  const type = el.type as { $$typeof?: symbol; _payload?: Chunk } | undefined;
  if (
    type != null &&
    typeof type === "object" &&
    type.$$typeof === REACT_LAZY
  ) {
    const payload = type._payload;
    if (payload && isUnsettled(payload)) out.push(payload);
  }
  collectPending(el.props?.children, out, budget);
}

/**
 * Resolves when the client references reachable through `children` from the
 * resolved content have loaded, or after CAP_MS, whichever comes first.
 */
export function settleClientReferences(
  content: Promise<ReactNode>,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, CAP_MS);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    content.then((node) => {
      const pending: Chunk[] = [];
      collectPending(node, pending, { left: MAX_NODES });
      if (pending.length === 0) done();
      else void Promise.allSettled(pending).then(done);
    }, done);
  });
}
