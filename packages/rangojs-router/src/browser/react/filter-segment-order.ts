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
 *    route handler's segment is appended (see fresh.ts:resolveSegment for
 *    routes, and revalidation.ts ~915-919), so matched can read
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
    if (/D\d+\./.test(id)) continue;
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
  // Defensive: any slot whose parent is missing from the filtered list still
  // gets included rather than silently dropped. Shouldn't happen in practice.
  for (const [parent, slots] of slotsByParent) {
    if (!nonSlotSet.has(parent)) result.push(...slots);
  }
  return result;
}
