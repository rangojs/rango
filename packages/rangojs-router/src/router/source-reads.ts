/**
 * Recording what revalidate() rules read of the source page, so a prefetch
 * answer a rule kept is shared between the pages with equal values of what
 * was read (prefetch-source-scope.ts, rango-t242).
 */

import {
  createSourceReads,
  formatSourceLabel,
  mergeSourceReads,
  PARAMS_SCOPE_PREFIX,
  shapeOfReads,
  type SourcePage,
  type SourceReads,
} from "../prefetch-source-scope.js";

/**
 * The source group of a match whose diff a source read decided: the reads
 * every kept decision made, unioned, and the source page they read.
 */
export interface SourceHeld extends SourcePage {
  reads: SourceReads;
}

/**
 * A copy of `params` whose reads land in `reads`: an enumerable getter per
 * key, so a spread, Object.entries, JSON.stringify or structuredClone reads
 * every key. Not a Proxy: structuredClone refuses one. A read of an absent
 * key is not recorded and needs no record: the key set is part of the group
 * (`reads.keys`), so a page in the group lacks that key too.
 */
export function recordingParams(
  params: Readonly<Record<string, string>>,
  reads: SourceReads,
): Record<string, string> {
  reads.keys = true;
  const view: Record<string, string> = {};
  for (const name of Object.keys(params)) {
    Object.defineProperty(view, name, {
      enumerable: true,
      configurable: true,
      get() {
        reads.params.add(name);
        return params[name];
      },
      // A rule may write to the object, as to the plain one it replaces:
      // what it wrote is its own value, not the source's.
      set(value: string) {
        Object.defineProperty(view, name, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      },
    });
  }
  return view;
}

/**
 * Add `reads` to the source group of the match `context` decides for. All
 * of one match's decisions read the same source page; a caller that reads
 * no route name passes none.
 */
export function markSourceHeld(
  context: { _sourceHeld?: SourceHeld },
  reads: SourceReads,
  page: SourcePage,
): void {
  const held = (context._sourceHeld ??= {
    reads: createSourceReads(),
    params: page.params,
    routeName: undefined,
  });
  if (page.routeName !== undefined) held.routeName = page.routeName;
  mergeSourceReads(held.reads, reads);
}

/**
 * The `x-rsc-prefetch-scope` of a partial response, or undefined when every
 * source page may share it.
 *
 * - `source`: the exact source page's. A route an intercept targets renders
 *   the modal or the full page depending on the source, so a full page
 *   prefetched where the intercept does not apply would otherwise serve a
 *   later click where it does (#1007); a response with deferred units
 *   answers one page's prefetch (`sourceOnly`); a kept rule that read
 *   `currentUrl` can depend on anything in it; and a source-held answer that
 *   sends nothing (`sentNothing`) commits treeless on the page that adopts
 *   it, which keeps its whole tree without checking it holds the ids the
 *   answer kept (partial-update.ts): only the source is known to hold them.
 * - `params; <label>`: a revalidate() rule read the source's params or route
 *   name and kept a segment. A page that adopted the answer would keep its
 *   own copy of that segment (#1331), which is right only where the rule
 *   decides the same: on pages with equal values of what it read. The label
 *   names them (prefetch-source-scope.ts); the browser stores the answer
 *   under it. A page that lacks a kept id refetches (the commit's
 *   missing-segment check), as for a shared answer.
 */
export function prefetchScopeOf(
  sourceOnly: boolean,
  held: SourceHeld | undefined,
  sentNothing: boolean,
): string | undefined {
  if (sourceOnly) return "source";
  if (!held) return undefined;
  if (held.reads.url || sentNothing) return "source";
  return (
    PARAMS_SCOPE_PREFIX + formatSourceLabel(shapeOfReads(held.reads), held)
  );
}

/** Every param of the source read: its params must equal the page's. */
export function readsOfAllParams(
  params: Readonly<Record<string, string>>,
): SourceReads {
  const reads = createSourceReads();
  reads.keys = true;
  for (const name of Object.keys(params)) reads.params.add(name);
  return reads;
}
