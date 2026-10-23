/**
 * A loader sub-id carries a `D${index}.` marker ("M0L0D1.user"). Non-global,
 * so `.test` and `.replace` are stateless.
 */
export const LOADER_SEGMENT_ID: RegExp = /D\d+\./;

/** True for a loader sub-id ("M0L0D1.user"), false for a layout/route/slot id. */
export function isLoaderSegmentId(id: string): boolean {
  return LOADER_SEGMENT_ID.test(id);
}

/**
 * The parent of a loader sub-id (`${parentId}D${index}.${loaderId}`); any
 * other id unchanged. parentId is a shortCode (never "D"), or
 * `${shortCode}.${slotName}` for an intercept slot's loaders, where the
 * user-chosen name may hold an uppercase "D" ("@Detail"). Strip from the first
 * `D<index>.`: splitting on a bare "D" mis-cut "@Detail" to "@" and silently
 * dropped the loader's data. Correct only because slot names cannot contain
 * "." (assertValidSlotName, route-definition/dsl-helpers.ts).
 */
export function loaderParentId(id: string): string {
  return id.replace(/D\d+\..*$/, "");
}

/**
 * Build the handle-collection segment order from a raw `matched` list.
 *
 * Two responsibilities:
 *
 * 1. Drop loader sub-ids ("D" followed by a digit, e.g. "M0L0D1.user") —
 *    loaders never push handles.
 *
 * 2. Place each parallel slot id (contains ".@") immediately after its
 *    parent layout/route id. Raw segment-resolution emission order does NOT
 *    guarantee this: route-mounted parallels are resolved/pushed BEFORE the
 *    route handler's segment is appended (see resolveSegmentWithRevalidation in
 *    segment-resolution/revalidation.ts), so matched can read
 *    `[..., R0.@panel, R0]`. collectHandleData consumes segmentOrder verbatim
 *    with later-wins semantics, so without normalization the route handler's
 *    Meta would override the slot's more-specific Meta — backwards.
 *
 * Slot-id format is `<parentShortCode>.@<slotName>`; `parentShortCode` never
 * contains ".@", so splitting at the first ".@" reliably yields the parent.
 */
export function filterSegmentOrder(matched: string[]): string[] {
  const slotsByParent = new Map<string, string[]>();
  const nonSlots: string[] = [];
  const nonSlotSet = new Set<string>();

  for (const id of matched) {
    if (isLoaderSegmentId(id)) continue;
    const slotIdx = id.indexOf(".@");
    if (slotIdx >= 0) {
      const parent = id.slice(0, slotIdx);
      const list = slotsByParent.get(parent);
      if (list) {
        list.push(id);
      } else {
        slotsByParent.set(parent, [id]);
      }
    } else {
      nonSlots.push(id);
      nonSlotSet.add(id);
    }
  }

  const result: string[] = [];
  for (const id of nonSlots) {
    result.push(id);
    const slots = slotsByParent.get(id);
    if (slots) result.push(...slots);
  }
  for (const [parent, slots] of slotsByParent) {
    if (!nonSlotSet.has(parent)) result.push(...slots);
  }
  return result;
}

/**
 * Build the "layouts and routes only" id list for useSegments().segmentIds.
 *
 * Strips parallel slot ids (contain ".@") and loader sub-ids ("D" followed by
 * a digit, e.g. "M0L0D1.user") without reordering. Distinct from
 * filterSegmentOrder, which also reorders slots after their parent for handle
 * collection.
 *
 * Shared by SSR (ssr/index.tsx) and the client event controller
 * (event-controller.ts) so both produce identical output; if they diverge,
 * useSegments().segmentIds rendered during SSR and after hydration disagree
 * and React reports a hydration mismatch.
 */
export function filterRouteSegmentIds(matched: string[]): string[] {
  return matched.filter((id) => !id.includes(".@") && !isLoaderSegmentId(id));
}
