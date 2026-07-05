// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Mock the prefetch executors and the viewport observer so the test asserts
// WHICH strategy the Link resolved (did it enqueue?) without any network or
// IntersectionObserver machinery. observeForPrefetch invokes its callback
// synchronously — the element is "in viewport" the moment it's observed.
vi.mock("../browser/prefetch/fetch.js", () => ({
  prefetchDirect: vi.fn(),
  prefetchQueued: vi.fn(() => "key"),
}));
vi.mock("../browser/prefetch/observer.js", () => ({
  observeForPrefetch: vi.fn((_el: Element, cb: () => void) => cb()),
  unobserveForPrefetch: vi.fn(),
}));

import { prefetchQueued } from "../browser/prefetch/fetch.js";
import { Link } from "../browser/react/Link.js";
import { NavigationStoreContext } from "../browser/react/context.js";
import type { NavigationStoreContextValue } from "../browser/react/context.js";
import {
  setDefaultPrefetchStrategy,
  getDefaultPrefetchStrategy,
} from "../browser/prefetch/default-strategy.js";
import { DEFAULT_PREFETCH_STRATEGY } from "../router/prefetch-default.js";

const ctxValue = {
  store: {
    getSegmentState: () => ({ currentSegmentIds: [] }),
    getRouterId: () => "router_test",
  },
  eventController: {
    getState: () => ({ state: "idle", isStreaming: false }),
    subscribe: () => () => {},
  },
  navigate: async () => {},
  refresh: async () => {},
  version: undefined,
  basename: undefined,
} as unknown as NavigationStoreContextValue;

let container: HTMLDivElement;
let root: Root;

function renderLink(props: { to: string; prefetch?: "viewport" | "none" }) {
  act(() => {
    root.render(
      <NavigationStoreContext.Provider value={ctxValue}>
        <Link to={props.to} prefetch={props.prefetch}>
          target
        </Link>
      </NavigationStoreContext.Provider>,
    );
  });
}

describe("Link default prefetch fallback", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setDefaultPrefetchStrategy(DEFAULT_PREFETCH_STRATEGY);
  });

  it("a bare Link viewport-prefetches under the built-in default", () => {
    expect(getDefaultPrefetchStrategy()).toBe("viewport");
    renderLink({ to: "/target" });
    expect(prefetchQueued).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prefetchQueued).mock.calls[0][0]).toBe("/target");
  });

  it("a bare Link does nothing under defaultPrefetch: none (manual mode)", () => {
    setDefaultPrefetchStrategy("none");
    renderLink({ to: "/target" });
    expect(prefetchQueued).not.toHaveBeenCalled();
  });

  it("an explicit prefetch prop wins over the router default in both directions", () => {
    // Opt OUT of an aggressive default.
    renderLink({ to: "/target", prefetch: "none" });
    expect(prefetchQueued).not.toHaveBeenCalled();

    // Opt IN under manual mode.
    setDefaultPrefetchStrategy("none");
    renderLink({ to: "/other", prefetch: "viewport" });
    expect(prefetchQueued).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prefetchQueued).mock.calls[0][0]).toBe("/other");
  });
});
