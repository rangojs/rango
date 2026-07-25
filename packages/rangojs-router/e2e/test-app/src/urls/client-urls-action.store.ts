/**
 * Module-level counter shared by the clientUrls action-revalidation fixture:
 * the server action bumps it, the projected loader and the parent RSC layout
 * both read it. The divergence between the two after an action is the pinned
 * contract (loader revalidates, parent-chain layout keeps the locked skip).
 */
let counter = 0;

export function getClientUrlsActionCount(): number {
  return counter;
}

export function bumpClientUrlsActionCount(): number {
  counter += 1;
  return counter;
}
