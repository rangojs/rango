// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { createNavigationStore } from "../browser/navigation-store.js";
import { createLocationState } from "../browser/react/location-state-shared.js";
import { decideCommitGatedOff } from "../browser/transition-when.js";
import { withLocationStateKey } from "../testing/location-state-key.js";
import type {
  ResolvedSegment,
  TransitionWhenContext,
} from "../types/segments.js";

/**
 * Back/forward reads the entry being left (`from.state`) from the store's
 * per-entry memory, because at popstate history.state already belongs to the
 * destination. State written to the entry after its commit (Def.write(),
 * Def.delete(), a flash read clearing its slot) must reach that memory.
 */
function popFromState(store: ReturnType<typeof createNavigationStore>) {
  let seen: TransitionWhenContext | undefined;
  const when = (ctx: TransitionWhenContext) => {
    seen = ctx;
    return true;
  };
  decideCommitGatedOff(
    store,
    [{ id: "R", type: "route", transition: { when } } as ResolvedSegment],
    "pop",
    { to: () => ({ url: "/b" }) },
  );
  return seen!.from;
}

function setup() {
  const Tab = withLocationStateKey(createLocationState<string>(), "memTab");
  const store = createNavigationStore({
    initialLocation: { href: "http://localhost/a" },
    crossTabSync: false,
  });
  window.history.replaceState({ key: "entry-a" }, "", "/a");
  // The commit of entry A records its state then.
  Tab.write("details");
  store.rememberDisplayedEntry("a");
  return { Tab, store };
}

describe("per-entry memory follows writes after the commit", () => {
  it("Def.write() on the entry being left is visible to a pop's from.state", () => {
    const { Tab, store } = setup();
    Tab.write("reviews");
    // Back: history.state now belongs to the destination.
    window.history.pushState({ key: "entry-b" }, "", "/b");
    expect(Tab.read(popFromState(store))).toBe("reviews");
  });

  it("Def.delete() on the entry being left is visible too", () => {
    const { Tab, store } = setup();
    Tab.delete();
    window.history.pushState({ key: "entry-b" }, "", "/b");
    expect(Tab.read(popFromState(store))).toBeUndefined();
  });
});
