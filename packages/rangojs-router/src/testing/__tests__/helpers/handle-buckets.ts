/**
 * The handle values a served response delivers, by the segment id that owns
 * them — what a reader of `readHandles()`' hydration payload usually wants to
 * assert on, without the `pushedBy` bookkeeping around each value.
 */
import type { ServeShellRequestResult } from "../../flight.entry.js";
import { withoutPushedBy } from "../../../handles/pushed-by.js";

/** One entry per segment that received a push: segment id -> values. */
export async function handleBucketsOf(
  result: ServeShellRequestResult,
): Promise<Record<string, string[]>> {
  const handles = withoutPushedBy((await result.readHandles())!.hydration);
  return Object.fromEntries(
    Object.values(handles).flatMap((bySegment) =>
      Object.entries(bySegment).map(
        ([segmentId, values]) => [segmentId, values as string[]] as const,
      ),
    ),
  );
}
