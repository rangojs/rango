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

let adopting = false;

/**
 * Hand React the update of an adoption that waits for a fill. While `emit`
 * runs, useNavigation() pins `loading` as optimistic state of the update's
 * transition: where nothing can show a fallback React holds that transition
 * until the fill returns, and the state reads `loading` for as long, then
 * what the commit set.
 *
 * Scar tissue: the adoption commits in the task of the click, before
 * `loading` was ever rendered, and the state after the commit reaches React
 * inside the held transition. useNavigation() read idle for the whole wait.
 * Not pinned from outside the transition: the release would be a transition
 * of its own, one more commit, and under transition() one more view
 * transition, which the reveal then waits for.
 */
export function emitAdoption(emit: () => void): void {
  adopting = true;
  try {
    emit();
  } finally {
    adopting = false;
  }
}

/** Inside `emitAdoption`. */
export function isAdopting(): boolean {
  return adopting;
}
