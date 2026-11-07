/**
 * An intercept slot as the browser's tree build hands it to its parent's
 * outlet (segment-system.tsx renderSegments): the slot with its loader
 * segments' ids and aggregate on it, on a lane that settles loaders.
 *
 * A partial answer holds the slot and its loaders without the layout it hangs
 * from (the browser holds that), so the build gets a stand-in parent with the
 * slot's parent id.
 */
import { isValidElement, type ReactNode } from "react";
import { renderSegments } from "../../../segment-system.js";
import { isInterceptSegment } from "../../../browser/intercept-utils.js";
import type { ResolvedSegment } from "../../../types.js";

function slotIn(node: ReactNode, id: string): ResolvedSegment | undefined {
  if (!isValidElement(node)) return undefined;
  const props = node.props as {
    parallel?: ResolvedSegment[];
    children?: ReactNode;
  };
  return props.parallel?.find((p) => p.id === id) ?? slotIn(props.children, id);
}

export async function renderedSlot(
  segments: ResolvedSegment[],
  slotName: string,
): Promise<ResolvedSegment> {
  const intercept = segments.filter(isInterceptSegment);
  const slot = intercept.find(
    (s) => s.type === "parallel" && s.slot === slotName,
  );
  if (!slot) throw new Error(`no intercept slot ${slotName} in the segments`);
  const parent: ResolvedSegment = {
    id: slot.id.split(".")[0]!,
    namespace: "parent",
    type: "layout",
    index: 0,
    component: null,
    params: {},
  };
  const tree = await renderSegments([parent], {
    interceptSegments: intercept,
    forceAwait: true,
  });
  const rendered = slotIn(tree, slot.id);
  if (!rendered) throw new Error(`slot ${slot.id} not in the rendered tree`);
  return rendered;
}
