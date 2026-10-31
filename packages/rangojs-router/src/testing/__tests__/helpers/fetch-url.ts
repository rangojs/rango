import { writePartialParams } from "../../../browser/wire-protocol.js";

/**
 * The request URL navigation-client.ts builds: the keys derive from it.
 * Pinned to the client's own request by browser/__tests__/wire-urls.test.ts.
 */
export const fetchUrlOf = (
  to: string,
  from: string,
  ids: readonly string[],
): URL =>
  writePartialParams(new URL(to, from), {
    segmentIds: [...ids],
    emptySegments: "send",
  });
