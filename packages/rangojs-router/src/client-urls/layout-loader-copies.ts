import type { EntryData } from "../server/context.js";
import type { LoaderDefinition } from "../types.js";

/**
 * A clientUrls() layout()'s loaders are copied into every route record below
 * it (client-urls.ts applyConfig), and a loader segment's id names its route
 * (`${routeShortCode}D${index}.${$$id}`). On a navigation between two of the
 * layout's routes the destination's copy was a segment the client lacked, so
 * it ran whatever its revalidate() said.
 *
 * Materialization (server-projection.ts) records, for each copy, the ids the
 * same layout() loader has under the group's other routes of that layout. A
 * request whose page holds one of them holds the destination's copy: the
 * loader's revalidate() decides, as on a param navigation, and a held copy is
 * left out of the response. The browser carries the page's copy to the id
 * `matched` names (browser/segment-reconciler.ts) with its handle pushes
 * (handles/pushed-by.ts).
 *
 * A copy takes a server layout's revalidation default, not its route's: held
 * on a navigation, params or search changes included, and re-run on an action
 * (isLayoutLoaderCopy, segment-resolution/revalidation.ts).
 *
 * Keyed by the materialized loader stub, created once per evaluation of the
 * route: the ids depend on the route's shortCode and its siblings'.
 */
const copies = new WeakMap<LoaderDefinition<any>, readonly string[]>();

export function setLayoutLoaderCopies(
  stub: LoaderDefinition<any>,
  ids: readonly string[],
): void {
  copies.set(stub, ids);
}

/** True for the materialized stub of a clientUrls() layout() loader copy. */
export function isLayoutLoaderCopy(stub: LoaderDefinition<any>): boolean {
  return copies.has(stub);
}

/**
 * `held` with the id of each of `route`'s layout() loader copies whose
 * loader the page holds under another route of the layout; `held` itself
 * when there is none.
 */
export function withLayoutLoaderCopies(
  held: ReadonlySet<string>,
  route: EntryData,
): ReadonlySet<string> {
  let out: Set<string> | undefined;
  route.loader?.forEach(({ loader }, index) => {
    if (copies.get(loader)?.some((id) => held.has(id))) {
      (out ??= new Set(held)).add(`${route.shortCode}D${index}.${loader.$$id}`);
    }
  });
  return out ?? held;
}
