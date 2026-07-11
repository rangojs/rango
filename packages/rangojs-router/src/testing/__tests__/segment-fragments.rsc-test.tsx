// Fragment envelope round-trip through the REAL Flight codec (issue #700):
// the PPR fast-path HIT payload carries STORED fragment strings verbatim and
// the consumer (SSR resume / browser hydration) expands them through its own
// Flight deserializer. This pins, at the unit tier with the real wire format,
// that a stored fragment string decodes on the CLIENT side to the same
// inspectable tree a direct serialize -> deserialize produces — client
// boundary preserved as an island (I-row), typed props (Date) intact, text
// content identical. Serialized via the public @rangojs/router/testing/flight
// surface (renderServerTree); the decoder is the same vendored Flight client
// the production browser/SSR consumers wrap.
import { describe, expect, test } from "vitest";
import { renderServerTree, findClientBoundaries } from "../flight.entry.js";
import { textContent } from "../flight.entry.js";
import { deserializeFlight } from "../flight-tree.js";
import {
  segmentFragment,
  expandSegmentFragments,
  isSegmentFragment,
} from "../../segment-fragments.js";
import type { ResolvedSegment } from "../../types.js";
import { Counter } from "./fixtures/Counter.js";

function makeSegment(component: unknown): ResolvedSegment {
  return {
    id: "seg-frag",
    namespace: "test",
    type: "route",
    index: 0,
    component,
    params: {},
  } as ResolvedSegment;
}

/** The consumer expansion decoder: the vendored Flight client over the stored
 *  string — exactly what expandSegmentFragments receives in production (the
 *  browser's / SSR runtime's createFromReadableStream). */
async function clientDecode(stream: ReadableStream<Uint8Array>) {
  return deserializeFlight(await new Response(stream).text());
}

describe("segment fragment round-trip (real Flight)", () => {
  test("a stored fragment expands client-side to the direct-decode tree: island + typed props + text", async () => {
    const asOf = new Date("2026-07-01T00:00:00Z");
    function Page() {
      return (
        <main>
          <h1>Baked shell heading</h1>
          <Counter start={42} when={asOf} tags={new Map([["cart", 1]])} />
        </main>
      );
    }

    // Reference: the direct serialize -> deserialize path (today's HIT tail).
    const { flight, tree: direct } = await renderServerTree(<Page />);
    expect(flight).toContain("I["); // Counter crossed as a real boundary

    // Fragment path: the SAME stored string rides the payload verbatim and the
    // consumer expands it.
    const segment = makeSegment(segmentFragment(flight));
    expect(isSegmentFragment(segment.component)).toBe(true);
    await expandSegmentFragments([segment], clientDecode);
    expect(isSegmentFragment(segment.component)).toBe(false);

    // Same island, same typed props.
    const directBoundaries = findClientBoundaries(direct, "Counter");
    const expandedBoundaries = findClientBoundaries(
      segment.component,
      "Counter",
    );
    expect(directBoundaries).toHaveLength(1);
    expect(expandedBoundaries).toHaveLength(1);
    expect(expandedBoundaries[0].props.start).toBe(42);
    expect(expandedBoundaries[0].props.when).toBeInstanceOf(Date);
    expect((expandedBoundaries[0].props.when as Date).toISOString()).toBe(
      asOf.toISOString(),
    );
    expect(expandedBoundaries[0].props.tags).toBeInstanceOf(Map);
    expect(
      (expandedBoundaries[0].props.tags as Map<string, number>).get("cart"),
    ).toBe(1);

    // Same rendered text content as the direct decode.
    expect(textContent(segment.component)).toBe(textContent(direct));
    expect(textContent(segment.component)).toContain("Baked shell heading");
  });

  test("layout and loading fragments expand independently (own row space per fragment)", async () => {
    async function Layout() {
      await Promise.resolve();
      return <aside data-part="layout">Chrome</aside>;
    }
    function Loading() {
      return <p>Loading...</p>;
    }

    const [{ flight: layoutFlight }, { flight: loadingFlight }] =
      await Promise.all([
        renderServerTree(<Layout />),
        renderServerTree(<Loading />),
      ]);

    const segment = makeSegment(null);
    segment.layout = segmentFragment(layoutFlight) as unknown as null;
    segment.loading = segmentFragment(loadingFlight) as unknown as null;
    await expandSegmentFragments([segment], clientDecode);

    expect(textContent(segment.layout)).toContain("Chrome");
    expect(textContent(segment.loading)).toContain("Loading...");
  });
});
