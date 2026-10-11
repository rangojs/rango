// @vitest-environment happy-dom
import { Suspense, useEffect, type ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ParallelOutlet } from "../client.js";
import { OutletContext } from "../outlet-context.js";
import type { ResolvedSegment } from "../types.js";
import { Defer } from "../browser/defer.js";

// A slot's wrapper chain is built where the layout renders it
// (client.tsx renderSlotContent), from the slot segment's own fields. A slot
// that streams with no loading() gets a boundary with no fallback around its
// promise. A deferred slot (`prefetch: false`, below a deferred unit) has a
// hole, the defer the fill resolves, but the slot it stands for was awaited:
// a navigation renders its content with no boundary around it. The hole has
// to stand where that content will, or the next render from the filled page
// finds another element there and mounts the slot again: React reads it
// there itself, its promise while pending and its value once fulfilled
// (browser/defer.ts holeNode).

afterEach(cleanup);

function slot(overrides: Partial<ResolvedSegment>): ResolvedSegment {
  return {
    id: "L0.@side",
    namespace: "side",
    type: "parallel",
    slot: "@side",
    index: 0,
    component: null,
    ...overrides,
  } as ResolvedSegment;
}

let fallbacks = 0;
function Outer(): ReactNode {
  useEffect(() => {
    fallbacks++;
  }, []);
  return <p>outer</p>;
}

async function show(segment: ResolvedSegment): Promise<string | null> {
  fallbacks = 0;
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <OutletContext.Provider value={{ content: null, parallel: [segment] }}>
        <Suspense fallback={<Outer />}>
          <div data-testid="layout">
            <ParallelOutlet name="@side" />
          </div>
        </Suspense>
      </OutletContext.Provider>,
    );
  });
  return view.container.textContent;
}

describe("a slot with no loading() whose component is a promise", () => {
  const pending = (): ReactNode =>
    new Promise<ReactNode>(() => {}) as unknown as ReactNode;

  it("gets its own boundary when it is a stream: the layout around it shows", async () => {
    expect(await show(slot({ component: pending() }))).toBe("");
  });

  it("gets none when it is a deferred slot's hole: the read suspends where the content will be", async () => {
    const hole = new Defer<ReactNode>() as unknown as ReactNode;
    expect(await show(slot({ component: hole, deferred: true }))).toBe("outer");
  });

  // The place a failed fill hands its resolved defer again
  // (browser/partial-update.ts fillHoles): the value, no fallback.
  it("renders a fulfilled hole's value where the content will be, with no fallback", async () => {
    const hole = new Defer<ReactNode>();
    hole.resolve(<b>side</b>);
    expect(await show(slot({ component: hole as unknown as ReactNode }))).toBe(
      "side",
    );
    expect(fallbacks).toBe(0);
  });

  it("renders a filled slot's content with no boundary around it", async () => {
    expect(await show(slot({ component: <b>side</b> }))).toBe("side");
  });
});
