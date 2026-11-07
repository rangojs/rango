/**
 * Loaders, actions and the shared revalidate() predicate of the
 * clientUrls-outer-layout fixture. The predicate lives in a module without
 * "use client", so the server layout around the group and the group's own
 * layout() loader import the same function (an imported predicate is what
 * the revalidate() hoist accepts).
 */
import { createLoader } from "../../../index.rsc.js";
import type { LoaderDefinition, ShouldRevalidateFn } from "../../../types.js";

export const runs: Record<string, number> = {};
export const count = (name: string): number => runs[name] ?? 0;
/** What started or ended, in order, across the outer handler and loaders. */
export const events: string[] = [];
export const resetRuns = (): void => {
  for (const key of Object.keys(runs)) delete runs[key];
  events.length = 0;
};
export const bump = (name: string): void => {
  runs[name] = count(name) + 1;
};

export async function cartAction(): Promise<void> {}
export async function otherAction(): Promise<void> {}

/**
 * The chrome's freshness rule: re-run on a cart action and on a navigation
 * into the cart route, hold everywhere else. Scoped with isAction(ref), so
 * an unrelated action holds the chrome.
 */
export const chromeChanged: ShouldRevalidateFn = ({ isAction, toRouteName }) =>
  isAction() ? isAction(cartAction) : toRouteName === "shop.cart";

type Counted = LoaderDefinition<{ value: string }>;

function counted(name: string): Counted {
  return createLoader(async () => {
    events.push(`${name}:start`);
    bump(name);
    return { value: `${name}-run-${count(name)}` };
  });
}

/** The group layout()'s chrome loader, revalidated by chromeChanged. */
export const BadgeLoader: Counted = counted("badge");
/** The item route's own loader. */
export const ItemLoader: Counted = counted("item");
