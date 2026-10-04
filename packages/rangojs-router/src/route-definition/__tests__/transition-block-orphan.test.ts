/**
 * Orphan classification must see through a wrapper-form transition().
 *
 * `layout(Shell, () => [transition(cfg, () => [route(...)])])` has routes — they
 * just sit inside the transition block. hasRoutesInItem used to stop at the
 * transition item (it carried no `uses`), so the layout was classified orphan,
 * detached from its parent and pushed onto the PARENT's layout[] — the list of
 * wrappers rendered around the parent's ENTIRE content. Shell then wrapped
 * every sibling route (test-app: TxBlockShell rendered around "/"), and a live
 * layout loader placed on it broke every PPR shell capture. The docs recommend
 * this exact shape (view-transitions guide: layout(<ShopShell />, () => [
 * transition(...)])).
 */
import { describe, it, expect } from "vitest";
import { parentEntry, withDslStore } from "./dsl-test-helpers.js";
import { cache, layout, route, transition } from "../dsl-helpers.js";
import { urls } from "../../urls.js";
import { findLazyIncludes } from "../../router/lazy-includes.js";
import type { AllUseItems } from "../../route-types.js";

function Shell() {
  return null;
}
function Page() {
  return null;
}

describe("wrapper-form transition() and orphan classification", () => {
  it("a layout whose only child is a transition block WITH routes is not an orphan", () => {
    const parent = parentEntry();
    const item = withDslStore(parent, () =>
      layout(Shell, () => [transition({}, () => [route("a", Page)])]),
    );
    // Not pushed onto the parent's wrapper list: it wraps only its own routes.
    expect(parent.layout).toHaveLength(0);
    // The transition item exposes its children so hasRoutesInItem can recurse.
    const tx = item.uses?.find((u) => u?.type === "transition");
    expect(tx?.uses?.some((u) => u?.type === "route")).toBe(true);
  });

  it("a cache block whose only child is a transition block WITH routes is not an orphan", () => {
    const parent = parentEntry();
    withDslStore(parent, () =>
      cache({ ttl: 60 }, () => [transition({}, () => [route("b", Page)])]),
    );
    expect(parent.layout).toHaveLength(0);
  });

  it("a layout with only a child-form transition() (no routes) stays an orphan wrapper", () => {
    const parent = parentEntry();
    withDslStore(parent, () => layout(Shell, () => [transition({})]));
    expect(parent.layout).toHaveLength(1);
  });

  it("a lazy include() inside a transition block is discovered (transition items expose uses)", () => {
    // findLazyIncludes walks `uses` structurally; before the transition item
    // carried its children, an include nested in a transition block was a
    // dead end and never registered.
    const patterns = urls(({ layout, transition, include }) => [
      layout(Shell, () => [
        transition({}, () => [
          include("/shop", () => Promise.resolve({ default: urls(() => []) })),
        ]),
      ]),
    ]);
    // The router runs urls().handler inside its build context and hands the
    // resulting items to findLazyIncludes (router.ts).
    const items = withDslStore(parentEntry(), () =>
      (patterns as unknown as { handler: () => AllUseItems[] }).handler(),
    );
    const lazy = findLazyIncludes(items);
    expect(lazy.map((l) => l.prefix)).toEqual(["/shop"]);
  });

  it("a layout over a transition block that itself has no routes stays an orphan wrapper", () => {
    const parent = parentEntry();
    withDslStore(parent, () =>
      layout(Shell, () => [transition({}, () => [transition({})])]),
    );
    expect(parent.layout).toHaveLength(1);
  });
});
