/**
 * No revalidate() argument carries the page navigated away from untracked,
 * so a new one cannot (#1331).
 *
 * A predicate that reads the page navigated away from and keeps the segment
 * decided for that page only: evaluateRevalidation (router/revalidation.ts)
 * passes each source field as a getter that notes the read, and the keep
 * then scopes a prefetch of the answer to its source
 * (`x-rsc-prefetch-scope: source`). A source field passed as a plain value
 * lets that keep be shared with every source page, which renders its own
 * copy of the segment.
 *
 * Which fields describe the source is measured, not declared: the predicate
 * runs for one destination from two source pages, and every field that is
 * not a read-noting getter must come out the same. Each segment kind and
 * method is run, so the seed (`defaultShouldRevalidate`) is covered too; a
 * source that is the destination itself is the same page, which is never
 * prefetched.
 *
 * `context` is the one known untracked channel. It is the destination's
 * handler context, the same object in both runs here, but in production its
 * `request` carries `X-RSC-Router-Client-Path` and the raw URL with
 * `_rsc_segments`, and a predicate (or a middleware var it reads) can read
 * the source through it. Whether that is in contract is the owner's call.
 *
 * The type side is FIELDS: a field added to or removed from
 * ShouldRevalidateFn's argument fails typecheck until it is listed here.
 */
import { describe, expect, it } from "vitest";
import { evaluateRevalidation } from "../revalidation.js";
import { runWithRequestContext } from "../../server/request-context.js";
import { createTestRequestContext } from "../../testing/internal/context.js";
import type { ResolvedSegment, ShouldRevalidateFn } from "../../types.js";

type RevalidateArgs = Parameters<ShouldRevalidateFn>[0];

const FIELDS = {
  currentParams: true,
  currentUrl: true,
  fromRouteName: true,
  nextParams: true,
  nextUrl: true,
  routeName: true,
  toRouteName: true,
  segmentType: true,
  layoutName: true,
  slotName: true,
  context: true,
  method: true,
  stale: true,
  actionId: true,
  isAction: true,
  actionUrl: true,
  actionResult: true,
  formData: true,
  defaultShouldRevalidate: true,
} as const satisfies Record<keyof RevalidateArgs, true>;

type Field = keyof typeof FIELDS;

/** The page navigated away from. */
interface Source {
  url: string;
  params: Record<string, string>;
  routeKey: string;
}

const SOURCES: readonly [Source, Source] = [
  { url: "http://localhost/item/1?s=a", params: { id: "1" }, routeKey: "item" },
  { url: "http://localhost/list/3?s=b", params: { id: "3" }, routeKey: "list" },
];

const DESTINATION = "http://localhost/item/2";

/**
 * The segment kinds evaluateRevalidation seeds differently. A parallel slot
 * the client does not hold is seeded by its call site
 * (segment-resolution/revalidation.ts): under a held parent with
 * "skip-parent-chain", which a predicate may keep.
 */
const KINDS: readonly {
  name: string;
  type: ResolvedSegment["type"];
  belongsToRoute: boolean;
  defaultOverride?: { value: boolean; reason: string };
}[] = [
  { name: "a route", type: "route", belongsToRoute: true },
  { name: "a route's loader", type: "loader", belongsToRoute: true },
  { name: "a layout", type: "layout", belongsToRoute: false },
  { name: "a layout's loader", type: "loader", belongsToRoute: false },
  { name: "a layout's parallel slot", type: "parallel", belongsToRoute: false },
  { name: "a route's parallel slot", type: "parallel", belongsToRoute: true },
  {
    name: "a parallel slot the client does not hold, under a held layout",
    type: "parallel",
    belongsToRoute: false,
    defaultOverride: { value: false, reason: "skip-parent-chain" },
  },
];

const formData = new FormData();
const handlerContext = {};

/**
 * Run `fn` as the router runs a segment's predicate on a request from
 * `source` to the destination.
 */
async function evaluate(
  fn: ShouldRevalidateFn,
  {
    source = SOURCES[0],
    method = "GET",
    kind = KINDS[2]!,
  }: {
    source?: Source;
    method?: string;
    kind?: (typeof KINDS)[number];
  } = {},
): Promise<{ decision: boolean; sourceHeld: boolean }> {
  const request = new Request(DESTINATION, { method });
  const { ctx } = createTestRequestContext({ request, params: { id: "2" } });
  ctx._prevRouteKey = source.routeKey;
  const context = handlerContext as { _sourceHeld?: unknown };
  delete context._sourceHeld;
  const decision = await runWithRequestContext(ctx as never, () =>
    evaluateRevalidation({
      segment: {
        id: "M0L0",
        namespace: "",
        index: 0,
        component: null,
        type: kind.type,
        belongsToRoute: kind.belongsToRoute,
        layoutName: kind.type === "layout" ? "shell" : undefined,
        slot: kind.type === "parallel" ? "@side" : undefined,
        params: { id: "2" },
      } as ResolvedSegment,
      defaultOverride: kind.defaultOverride,
      prevParams: source.params,
      getPrevSegment: null,
      request,
      prevUrl: new URL(source.url),
      nextUrl: new URL(DESTINATION),
      revalidations: [{ name: "revalidate0", fn }],
      routeKey: "item",
      context: context as never,
      actionContext:
        method === "POST"
          ? {
              actionId: "act#1",
              actionUrl: new URL(DESTINATION),
              actionResult: { ok: true },
              formData,
            }
          : undefined,
    }),
  );
  const sourceHeld = context._sourceHeld !== undefined;
  delete context._sourceHeld;
  return { decision, sourceHeld };
}

/** The argument object a predicate receives, its getters not invoked. */
async function argumentsOf(
  options: Parameters<typeof evaluate>[1],
): Promise<RevalidateArgs> {
  let received: RevalidateArgs | undefined;
  await evaluate((args) => {
    received = args;
    return true;
  }, options);
  return received!;
}

/**
 * A getter that notes a read of the source page. The seed's getter notes
 * only that the rule saw the seed (a route's default compares the target
 * with the source, revalidation.ts decide): it is measured as a value.
 */
const isTracked = (args: RevalidateArgs, field: Field): boolean =>
  field !== "defaultShouldRevalidate" &&
  typeof Object.getOwnPropertyDescriptor(args, field)?.get === "function";

/** A field's value as comparable data. */
function valueOf(args: RevalidateArgs, field: Field): unknown {
  const value = args[field];
  if (field === "isAction") return (value as () => boolean)();
  if (value instanceof URL) return value.href;
  return value;
}

describe("revalidate() arguments: only a tracked getter may carry the source page", () => {
  it.each(["GET", "POST"])(
    "a %s predicate receives exactly the listed fields",
    async (method) => {
      const args = await argumentsOf({ method });
      expect(
        Reflect.ownKeys(args).filter((key) => !(key in FIELDS)),
        "revalidate() receives a field FIELDS does not list. List it, and if " +
          "it can differ between source pages, pass it as a getter that notes " +
          "the read (router/revalidation.ts evaluateRevalidation), so a " +
          "segment it keeps scopes the prefetch to its source (#1331).",
      ).toEqual([]);
      expect(
        (Object.keys(FIELDS) as Field[]).filter((field) => !(field in args)),
        "FIELDS lists a field revalidate() no longer receives",
      ).toEqual([]);
    },
  );

  describe.each(["GET", "POST"])("%s", (method) => {
    it.each(KINDS)(
      "for $name, every field that is not a tracked getter is the same from two source pages",
      async (kind) => {
        const first = await argumentsOf({ source: SOURCES[0], method, kind });
        const second = await argumentsOf({ source: SOURCES[1], method, kind });
        for (const field of Object.keys(FIELDS) as Field[]) {
          if (isTracked(first, field) && isTracked(second, field)) continue;
          expect(
            valueOf(second, field),
            `${field} differs between source pages but is a plain value: it ` +
              "describes the source page and must be tracked through a read " +
              "getter (router/revalidation.ts evaluateRevalidation)",
          ).toEqual(valueOf(first, field));
        }
      },
    );
  });

  it("every tracked getter differs between the two source pages, so the run measures them", async () => {
    const first = await argumentsOf({ source: SOURCES[0] });
    const second = await argumentsOf({ source: SOURCES[1] });
    const getters = (Object.keys(FIELDS) as Field[]).filter((field) =>
      isTracked(first, field),
    );
    expect(getters.length).toBeGreaterThan(0);
    for (const field of getters) {
      expect(valueOf(second, field), field).not.toEqual(valueOf(first, field));
    }
  });

  it.each(Object.keys(FIELDS) as Field[])(
    "%s: a segment of every kind kept after reading it is source-held exactly when it is a tracked getter",
    async (field) => {
      const tracked = isTracked(await argumentsOf({}), field);
      for (const kind of KINDS) {
        const { decision, sourceHeld } = await evaluate(
          (a) => {
            void a[field];
            return false;
          },
          { kind },
        );
        expect(decision, kind.name).toBe(false);
        expect(
          sourceHeld,
          tracked
            ? `${kind.name} kept after reading ${field} must mark the match source-held`
            : `reading ${field} must not scope ${kind.name} kept to its source`,
        ).toBe(tracked);
      }
    },
  );
});
