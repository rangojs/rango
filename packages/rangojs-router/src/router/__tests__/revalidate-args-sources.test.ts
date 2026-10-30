/**
 * Every field a revalidate() predicate receives is classed by the page it
 * describes, so a new field that describes the source page cannot go
 * untracked (#1331).
 *
 * A predicate that reads the page navigated away from and keeps the segment
 * decided for that page only: evaluateRevalidation (router/revalidation.ts)
 * passes each source field as a getter that notes the read, and the keep
 * then scopes a prefetch of the answer to its source
 * (`x-rsc-prefetch-scope: source`). A source field passed as a plain value
 * lets that keep be shared with every source page, which renders its own
 * copy of the segment.
 *
 * The type side is the `satisfies` below: a field added to or removed from
 * ShouldRevalidateFn's argument fails typecheck until it is classed here.
 * The runtime side enumerates the object evaluateRevalidation builds.
 */
import { describe, expect, it } from "vitest";
import { evaluateRevalidation } from "../revalidation.js";
import type { ShouldRevalidateFn } from "../../types.js";

type RevalidateArgs = Parameters<ShouldRevalidateFn>[0];

/**
 * - source: the page navigated away from. Passed as a read-noting getter.
 * - destination: the target route, URL or segment.
 * - request: the request itself. An action's fields are set on a POST only,
 *   which is never prefetched; `context` is the destination's handler
 *   context.
 * - seed: the router's default. On a navigation it keeps a route segment
 *   only on equal params and search (the same page, never prefetched) and
 *   a layout whatever the source.
 */
const FIELDS = {
  currentParams: "source",
  currentUrl: "source",
  fromRouteName: "source",
  nextParams: "destination",
  nextUrl: "destination",
  routeName: "destination",
  toRouteName: "destination",
  segmentType: "destination",
  layoutName: "destination",
  slotName: "destination",
  context: "request",
  method: "request",
  stale: "request",
  actionId: "request",
  isAction: "request",
  actionUrl: "request",
  actionResult: "request",
  formData: "request",
  defaultShouldRevalidate: "seed",
} as const satisfies Record<
  keyof RevalidateArgs,
  "source" | "destination" | "request" | "seed"
>;

type Field = keyof typeof FIELDS;

const SOURCE_FIELDS = (Object.keys(FIELDS) as Field[]).filter(
  (field) => FIELDS[field] === "source",
);
const OTHER_FIELDS = (Object.keys(FIELDS) as Field[]).filter(
  (field) => FIELDS[field] !== "source",
);

/** Run `fn` as the router runs a layout's predicate on a navigation. */
async function evaluate(
  fn: ShouldRevalidateFn,
  method = "GET",
): Promise<{ decision: boolean; sourceHeld: boolean }> {
  const context: { _sourceHeld?: true } = {};
  const decision = await evaluateRevalidation({
    segment: { id: "M0L0", type: "layout", params: { id: "2" } } as any,
    prevParams: { id: "1" },
    getPrevSegment: null,
    request: new Request("http://localhost/item/2", { method }),
    prevUrl: new URL("http://localhost/item/1"),
    nextUrl: new URL("http://localhost/item/2"),
    revalidations: [{ name: "revalidate0", fn }],
    routeKey: "item",
    context: context as any,
  });
  return { decision, sourceHeld: context._sourceHeld === true };
}

/** The argument object a predicate receives, its getters not invoked. */
async function argumentsOf(method: string): Promise<RevalidateArgs> {
  let received: RevalidateArgs | undefined;
  await evaluate((args) => {
    received = args;
    return true;
  }, method);
  return received!;
}

describe("revalidate() arguments: every field is classed by the page it describes", () => {
  it.each(["GET", "POST"])(
    "a %s predicate receives exactly the classed fields",
    async (method) => {
      const args = await argumentsOf(method);
      const unclassed = Reflect.ownKeys(args).filter((key) => !(key in FIELDS));
      expect(
        unclassed,
        "revalidate() receives a field FIELDS does not class. A field read " +
          "from the page navigated away from is a source field: pass it as " +
          "a getter that notes the read (router/revalidation.ts " +
          "evaluateRevalidation), so a segment it keeps scopes the prefetch " +
          "to its source (#1331).",
      ).toEqual([]);
      expect(
        (Object.keys(FIELDS) as Field[]).filter((field) => !(field in args)),
        "FIELDS classes a field revalidate() no longer receives",
      ).toEqual([]);
    },
  );

  it.each(SOURCE_FIELDS)(
    "the source field %s is a getter, and a segment kept after reading it is source-held",
    async (field) => {
      const args = await argumentsOf("GET");
      expect(
        Object.getOwnPropertyDescriptor(args, field)?.get,
        `${field} describes the source page and must be tracked through a read getter (router/revalidation.ts evaluateRevalidation)`,
      ).toBeTypeOf("function");
      const { decision, sourceHeld } = await evaluate((a) => {
        void a[field];
        return false;
      });
      expect(decision).toBe(false);
      expect(
        sourceHeld,
        `a segment kept after reading ${field} must mark the match source-held`,
      ).toBe(true);
    },
  );

  it.each(OTHER_FIELDS)(
    "the %s field does not scope a kept segment to its source",
    async (field) => {
      const { decision, sourceHeld } = await evaluate((a) => {
        void a[field];
        return false;
      });
      expect(decision).toBe(false);
      expect(sourceHeld).toBe(false);
    },
  );
});
