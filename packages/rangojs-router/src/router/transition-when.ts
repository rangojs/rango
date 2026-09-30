import { getParallelSlotEntries, type EntryData } from "../server/context.js";
import type { RequestContext } from "../server/request-context.js";
import type { TransitionWhenSite } from "../transition-when-ref.js";
import type { TransitionWhenFn } from "../types/segments.js";

/** A matched entry's transition({ when }) and where it was declared. */
export interface TransitionWhenRecord {
  readonly when: TransitionWhenFn;
  readonly site: TransitionWhenSite;
}

/**
 * Record the transition({ when }) references of a matched entry chain, keyed
 * by the segment id each entry resolves to. The server never calls them:
 * rsc/attach-transition-when.ts attaches them to the payload's segments right
 * before Flight, and the browser decides (browser/transition-when.ts).
 *
 * Recorded from the static route definition on EVERY match (fresh, cache hit,
 * prerender, PPR replay) because stored segments never carry them:
 * applyViewTransitionDefault strips `when` at resolution, since segment stores
 * JSON-serialize the transition config (dropping a function on some stores,
 * keeping it by reference on others). Segment ids follow resolution: an
 * entry's shortCode, and `${owner.shortCode}.${slot}` for a rendered parallel
 * slot.
 */
export function recordTransitionWhenRefs<TEnv>(
  entries: readonly EntryData[] | undefined,
  ctx: RequestContext<TEnv>,
  route: { routeName?: string; pattern?: string } = {},
): void {
  const refs = new Map<string, TransitionWhenRecord>();
  const visited = new Set<EntryData>();

  const record = (entry: EntryData, segmentId: string): void => {
    const when = entry.transition?.when;
    if (when === undefined) return;
    refs.set(segmentId, {
      when,
      site: { ...route, entryType: entry.type },
    });
  };

  const visitEntryAndOrphanLayouts = (entry: EntryData): void => {
    if (visited.has(entry)) return;
    visited.add(entry);
    record(entry, entry.shortCode);

    for (const orphan of entry.layout) visitEntryAndOrphanLayouts(orphan);
    for (const { slot, entry: parallelEntry } of getParallelSlotEntries(
      entry.parallel,
    )) {
      record(parallelEntry, `${entry.shortCode}.${slot}`);
    }
  };

  for (const entry of entries ?? []) visitEntryAndOrphanLayouts(entry);
  ctx._transitionWhenRefs = refs.size > 0 ? refs : undefined;
}
