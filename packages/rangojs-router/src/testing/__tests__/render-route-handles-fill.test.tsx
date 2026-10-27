// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { Profiler, Suspense, use, type ReactNode } from "react";
import { act, cleanup } from "@testing-library/react";
import { createNavigationTransaction } from "../../browser/navigation-transaction.js";
import { createPartialUpdater } from "../../browser/partial-update.js";
import { consumeHandles } from "../../browser/react/NavigationProvider.js";
import { useHandle } from "../../browser/react/use-handle.js";
import { Defer, readDefer } from "../../browser/defer.js";
import { createHandle } from "../../handle.js";
import type { ResolvedSegment } from "../../types.js";
import { renderRoute } from "../render-route.js";

/**
 * Userland (hook lock row: `prefetch: false` fills): a click adopts a payload
 * whose route is deferred, and its fill pushes a handle value. The reader
 * keeps the value of the page being left until the fill brings the page's own,
 * which lands after the click's commit (partial-update.ts fillHoles ->
 * fill.handles), never over the page being left.
 */

const Titles = createHandle<string, string[]>(
  (segments) => segments.flat(),
  "__test_userland_fill_titles__",
);
const UNIT = "U";

afterEach(() => {
  cleanup();
});

const text = (id: string): string =>
  Array.from(
    document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
  ).find((el) => !el.closest('[style*="display: none"]'))?.textContent ?? "";

function Title(): ReactNode {
  return <p data-testid="title">{useHandle(Titles).at(-1)}</p>;
}

function Home(): ReactNode {
  return (
    <>
      <Title />
      <p data-testid="page">home</p>
    </>
  );
}

function Unit({ content }: { content: unknown }): ReactNode {
  return (
    <p data-testid="page">
      {
        (content instanceof Defer
          ? readDefer(content)
          : content instanceof Promise
            ? use(content)
            : content) as ReactNode
      }
    </p>
  );
}

const tick = (ms = 0): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("renderRoute: a prefetch: false fill's handle value", () => {
  it("lands after the click and with the destination, never over the page being left", async () => {
    const log: string[] = [];
    const { router } = await renderRoute([{ path: "/", Component: Home }], {
      request: "/",
      handles: [[Titles, ["Home"]]],
    });
    const adopted = {
      id: UNIT,
      namespace: UNIT,
      type: "route",
      index: 0,
      component: null,
      params: {},
      loading: "skeleton",
      deferred: true,
    } as unknown as ResolvedSegment;
    const filled = {
      ...adopted,
      component: "content",
      deferred: undefined,
    } as unknown as ResolvedSegment;

    const held = router.store.getSegmentState().currentSegmentIds;
    const matched = [...held, UNIT];
    const payload = (segment: ResolvedSegment, handles?: object) => ({
      metadata: {
        isPartial: true,
        pathname: "/",
        matched,
        diff: [UNIT],
        segments: [segment],
        ...(handles
          ? {
              handles: (async function* () {
                yield handles;
              })(),
            }
          : {}),
      },
    });
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    const updater = createPartialUpdater({
      store: router.store,
      client: {
        fetchPartial: async (request: { fill?: boolean }) => {
          if (!request.fill) {
            return {
              payload: payload(adopted),
              streamComplete: Promise.resolve(),
              fullyPrefetched: true,
            };
          }
          await answered;
          return {
            payload: payload(filled, {
              [Titles.$$id]: { [UNIT]: ["Unit title"] },
            }),
            streamComplete: Promise.resolve(),
          };
        },
      } as any,
      onUpdate: (update) => router.store.emitUpdate(update),
      renderSegments: (segments) => (
        <Profiler
          id="fill"
          onRender={() => log.push(`${text("title")}|${text("page")}`)}
        >
          <Title />
          <Suspense fallback={<p data-testid="page">skeleton</p>}>
            <Unit content={segments.find((s) => s.id === UNIT)!.component} />
          </Suspense>
        </Profiler>
      ),
      fill: {
        redirect: () => {},
        locationState: () => {},
        handles: (metadata) => {
          if (metadata.handles) {
            consumeHandles(metadata, router.eventController, router.store);
          }
        },
        flush: router.eventController.flushRouteState,
      },
    });
    const here = window.location.href;
    const tx = createNavigationTransaction(
      router.store,
      router.eventController,
      here,
      { replace: true },
    );
    const navigation = updater(
      here,
      [],
      false,
      tx.handle.signal,
      tx.with({ url: here, replace: true }),
    ).finally(() => tx[Symbol.dispose]());
    await act(async () => {
      await Promise.race([navigation, tick()]);
    });
    expect(text("page")).toBe("skeleton");
    expect(text("title")).toBe("Home");

    await act(async () => {
      answer();
      await tick(50);
    });
    expect(text("page")).toBe("content");
    expect(text("title")).toBe("Unit title");
    // The value belongs to the destination: it never shows with the page
    // being left, and the first frame that shows it is after the click's.
    expect(log).not.toContain("Unit title|home");
    const clicked = log.indexOf("Home|skeleton");
    expect(clicked).toBeGreaterThanOrEqual(0);
    expect(clicked).toBeLessThan(
      log.findIndex((l) => l.startsWith("Unit title|")),
    );
    expect(log.at(-1)).toBe("Unit title|content");
  });
});
