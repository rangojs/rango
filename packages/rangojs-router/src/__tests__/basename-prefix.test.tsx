// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Link } from "../browser/react/Link.js";
import { NavigationStoreContext } from "../browser/react/context.js";
import type { NavigationStoreContextValue } from "../browser/react/context.js";
import { prefixBasename } from "../router/basename.js";

// One basename rule for redirect(), rewrite(), useRouter() and <Link>: a path
// that already carries the basename (followed by "/", "?", "#" or the end) is
// not prefixed again.

const CASES: Array<[string, string]> = [
  ["/settings", "/app/settings"],
  ["/", "/app"],
  ["/app", "/app"],
  ["/app/settings", "/app/settings"],
  ["/app?tab=1", "/app?tab=1"],
  ["/app#top", "/app#top"],
  ["/application", "/app/application"],
  ["https://other.test/x", "https://other.test/x"],
  ["relative", "relative"],
];

describe("prefixBasename", () => {
  it.each(CASES)("%s -> %s", (path, expected) => {
    expect(prefixBasename(path, "/app")).toBe(expected);
  });

  it("leaves every path alone without a basename", () => {
    expect(prefixBasename("/settings", undefined)).toBe("/settings");
  });
});

describe("<Link> prefixes with the basename once", () => {
  let container: HTMLDivElement;
  let root: Root;

  const ctxValue = {
    store: {
      getSegmentState: () => ({ currentSegmentIds: [] }),
      getRouterId: () => "router_test",
    },
    eventController: {
      getState: () => ({
        state: "idle",
        isStreaming: false,
        location: new URL(window.location.href),
      }),
      subscribe: () => () => {},
    },
    navigate: async () => {},
    refresh: async () => {},
    version: undefined,
    basename: "/app",
    origin: new URL(window.location.href).origin,
  } as unknown as NavigationStoreContextValue;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each(CASES.filter(([path]) => path.startsWith("/")))(
    "%s -> %s",
    (to, expected) => {
      act(() => {
        root.render(
          <NavigationStoreContext.Provider value={ctxValue}>
            <Link to={to} prefetch="none">
              target
            </Link>
          </NavigationStoreContext.Provider>,
        );
      });
      expect(container.querySelector("a")?.getAttribute("href")).toBe(expected);
    },
  );
});
