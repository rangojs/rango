// @vitest-environment happy-dom
/**
 * Pins the commit model of the source-independence tests
 * (helpers/browser-commit.ts) to production: the real navigation store,
 * event controller, bridge and partial updater commit the same answers, and
 * each case compares what production renders, the ids its next request
 * sends and whether it refetches with the model's. Only the server's answer
 * is faked. The model restates code in hook-locked files
 * (browser/partial-update.ts, browser/navigation-bridge.ts), which therefore
 * export nothing for it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventController } from "../../browser/event-controller.js";
import { createNavigationBridge } from "../../browser/navigation-bridge.js";
import {
  createNavigationStore,
  generateHistoryKey,
} from "../../browser/navigation-store.js";
import type {
  FetchPartialOptions,
  NavigationClient,
  ResolvedSegment,
  RscMetadata,
} from "../../browser/types.js";
import {
  commitAnswer,
  historyBase,
  type Answer,
  type Screen,
} from "./helpers/browser-commit.js";

const url = (path: string): string =>
  new URL(path, window.location.origin).href;

function seg(
  id: string,
  type: ResolvedSegment["type"],
  label: string,
): ResolvedSegment {
  return {
    id,
    namespace: "",
    index: 0,
    type,
    component: label,
  } as ResolvedSegment;
}

/** The page on screen: a held layout above A's route. */
const onScreen = (): Screen => ({
  href: url("/a"),
  segments: [seg("M0L0", "layout", "layout:a"), seg("M0L0R0", "route", "a")],
  matched: ["M0L0", "M0L0R0"],
});

/** B's history entry, from an earlier visit: its own copy of the layout. */
const entryOfB = (): ResolvedSegment[] => [
  seg("M0L0", "layout", "layout:b"),
  seg("M0L0R1", "route", "b"),
  seg("M0L0R1D0.data", "loader", "data:1"),
];

async function* noHandles(): AsyncGenerator<never> {}

function respond(answer: Answer, path: string) {
  return {
    payload: {
      metadata: {
        pathname: path,
        isPartial: true,
        matched: answer.matched,
        diff: answer.diff,
        segments: answer.segments,
        resolvedIds: answer.diff,
        params: {},
        handles: noHandles(),
      } as unknown as RscMetadata,
    },
    streamComplete: Promise.resolve(),
  };
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

/**
 * Production's commit of `answers` (one per request it sends) for a link to
 * /b from the page on screen, B's entry cached when `entry` is given.
 */
async function production(
  answers: Answer[],
  entry?: ResolvedSegment[],
  screen: Screen = onScreen(),
): Promise<{
  rendered: ResolvedSegment[];
  requests: FetchPartialOptions[];
  nextIds: string[];
}> {
  window.history.replaceState(null, "", "/a");
  const store = createNavigationStore({
    initialLocation: { href: screen.href },
    initialHistoryKey: generateHistoryKey(screen.href),
    initialSegments: screen.segments,
    initialSegmentIds: screen.matched,
    crossTabSync: false,
  });
  if (entry) {
    store.cacheSegmentsForHistory(generateHistoryKey(url("/b")), entry, {});
  }
  const eventController = createEventController({
    initialLocation: new URL(screen.href),
  });
  const requests: FetchPartialOptions[] = [];
  const queue = [...answers];
  const fetchPartial = vi.fn(async (options: FetchPartialOptions) => {
    requests.push(options);
    return respond(queue.shift()!, "/b");
  });
  let rendered = screen.segments;
  const bridge = createNavigationBridge({
    store,
    client: { fetchPartial } as unknown as NavigationClient,
    eventController,
    onUpdate: (update) => store.emitUpdate(update),
    renderSegments: async (segments) => {
      rendered = segments;
      return null;
    },
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await bridge.navigate(url("/b"));
  return {
    rendered,
    requests,
    nextIds: store.getSegmentState().currentSegmentIds,
  };
}

/** The model's commit of the same answers. */
function model(
  answers: Answer[],
  entry: ResolvedSegment[] | undefined,
  screen: Screen,
): { rendered: ResolvedSegment[]; refetched: boolean; nextIds: string[] } {
  const base = entry ? historyBase(entry, screen.segments) : undefined;
  const first = commitAnswer(answers[0]!, screen, base);
  if (first !== "missing") {
    return { rendered: first, refetched: false, nextIds: answers[0]!.matched };
  }
  const empty: Screen = { ...screen, segments: [], matched: [] };
  const second = commitAnswer(answers[1]!, empty);
  if (second === "missing") throw new Error("missing after the refetch");
  return { rendered: second, refetched: true, nextIds: answers[1]!.matched };
}

async function expectSame(
  answers: Answer[],
  entry?: ResolvedSegment[],
  screen: Screen = onScreen(),
): Promise<void> {
  const prod = await production(answers, entry, screen);
  const mine = model(answers, entry, screen);
  const view = (segments: ResolvedSegment[]) =>
    segments.map((s) => `${s.id}=${String(s.component)}`);
  expect(view(mine.rendered)).toEqual(view(prod.rendered));
  expect(mine.nextIds).toEqual(prod.nextIds);
  expect(prod.requests.length).toBe(mine.refetched ? 2 : 1);
  // A link to a page the history cache holds sends the entry's ids.
  expect(prod.requests[0]!.segmentIds).toEqual(
    entry ? entry.map((s) => s.id) : screen.matched,
  );
  if (mine.refetched) {
    expect(prod.requests[1]!.segmentIds).toEqual([]);
  }
}

const b = seg("M0L0R1", "route", "b:new");
const data = seg("M0L0R1D0.data", "loader", "data:2");

describe("the source-independence commit model renders what production commits", () => {
  it("reconciles a diff against the page on screen", async () => {
    await expectSame([
      { matched: ["M0L0", "M0L0R1"], diff: ["M0L0R1"], segments: [b] },
    ]);
  });

  it("keeps the tree on an empty diff (the treeless commit)", async () => {
    await expectSame([{ matched: ["M0L0", "M0L0R0"], diff: [], segments: [] }]);
  });

  it("renders a history entry's base on an empty diff, the page on screen's copy for a shared id", async () => {
    await expectSame(
      [
        {
          matched: ["M0L0", "M0L0R1", "M0L0R1D0.data"],
          diff: [],
          segments: [],
        },
      ],
      entryOfB(),
    );
  });

  it("renders the history entry's copy of an id the page on screen holds as a placeholder", async () => {
    const deferredLayout = {
      ...seg("M0L0", "layout", "layout:a"),
      deferred: true,
    } as ResolvedSegment;
    await expectSame(
      [
        {
          matched: ["M0L0", "M0L0R1", "M0L0R1D0.data"],
          diff: [],
          segments: [],
        },
      ],
      entryOfB(),
      {
        ...onScreen(),
        segments: [deferredLayout, seg("M0L0R0", "route", "a")],
      },
    );
  });

  it("reconciles a diff against a history entry's base", async () => {
    await expectSame(
      [
        {
          matched: ["M0L0", "M0L0R1", "M0L0R1D0.data"],
          diff: ["M0L0R1D0.data"],
          segments: [data],
        },
      ],
      entryOfB(),
    );
  });

  it("refetches holding nothing when a matched id is in neither", async () => {
    const layout = seg("M0L0", "layout", "layout:fresh");
    const other = seg("M0L0L1", "layout", "other");
    const route = seg("M0L0L1R0", "route", "c");
    await expectSame([
      {
        matched: ["M0L0", "M0L0L1", "M0L0L1R0"],
        diff: ["M0L0L1R0"],
        segments: [route],
      },
      {
        matched: ["M0L0", "M0L0L1", "M0L0L1R0"],
        diff: ["M0L0", "M0L0L1", "M0L0L1R0"],
        segments: [layout, other, route],
      },
    ]);
  });

  it("refetches holding nothing, with no history entry's base, when a matched id is in neither the entry nor the page", async () => {
    const layout = seg("M0L0", "layout", "layout:fresh");
    const other = seg("M0L0L1", "layout", "other");
    const route = seg("M0L0L1R0", "route", "c");
    await expectSame(
      [
        {
          matched: ["M0L0", "M0L0L1", "M0L0L1R0"],
          diff: ["M0L0L1R0"],
          segments: [route],
        },
        {
          matched: ["M0L0", "M0L0L1", "M0L0L1R0"],
          diff: ["M0L0", "M0L0L1", "M0L0L1R0"],
          segments: [layout, other, route],
        },
      ],
      entryOfB(),
    );
  });
});
