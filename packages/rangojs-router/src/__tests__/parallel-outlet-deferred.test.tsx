// @vitest-environment happy-dom
import { Suspense, type ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ParallelOutlet } from "../client.js";
import { OutletContext } from "../outlet-context.js";
import type { ResolvedSegment } from "../types.js";

// A slot's wrapper chain is built where the layout renders it
// (client.tsx renderSlotContent), from the slot segment's own fields. A slot
// that streams with no loading() gets a boundary with no fallback around its
// promise. A deferred slot (`prefetch: false`, below a deferred unit) has a
// promise too, the gate the fill resolves, but the slot it stands for was
// awaited: a navigation renders its content with no boundary around it. The
// gate has to stand where that content will, or the next render from the
// filled page finds another element there and mounts the slot again.

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

async function show(segment: ResolvedSegment): Promise<string | null> {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <OutletContext.Provider value={{ content: null, parallel: [segment] }}>
        <Suspense fallback={<p>outer</p>}>
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

  it("gets none when it is a deferred slot's gate: the read suspends where the content will be", async () => {
    expect(await show(slot({ component: pending(), deferred: true }))).toBe(
      "outer",
    );
  });

  it("renders a filled slot's content with no boundary around it", async () => {
    expect(await show(slot({ component: <b>side</b> }))).toBe("side");
  });
});
