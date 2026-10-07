/**
 * The one fill request in flight (`prefetch: false`,
 * docs/design/prefetch-false.md).
 *
 * A fill is not a navigation in the event controller: starting it must cancel
 * nothing, and a navigation that starts and then fails must not leave the
 * page with fallbacks nobody fills. So it is cancelled when the tree it
 * belongs to is replaced, by whoever replaces it: a committing navigation
 * transaction (navigation-transaction.ts), a back/forward
 * (navigation-bridge.ts handlePopstate) or a newer adoption
 * (partial-update.ts).
 */
let cancelPending: (() => void) | null = null;

/** Register the fill of the adoption that just committed. */
export function setPendingFill(cancel: () => void): void {
  cancelPendingFill();
  cancelPending = cancel;
}

/** Cancel the fill in flight, if any: its tree is being replaced. */
export function cancelPendingFill(): void {
  const cancel = cancelPending;
  cancelPending = null;
  cancel?.();
}

/** A fill that settled is no longer pending. */
export function clearPendingFill(cancel: () => void): void {
  if (cancelPending === cancel) cancelPending = null;
}
