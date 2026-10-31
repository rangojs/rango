import { describe, expect, it, vi } from "vitest";
import { findInterceptForRoute } from "../intercept-resolution.js";
import type {
  EntryData,
  InterceptEntry,
  InterceptSelectorContext,
} from "../../server/context.js";

/**
 * findInterceptForRoute: a navigation selects the first intercept along the
 * chain whose when() passes; an action selects the intercept the client
 * holds, by its slot id, and evaluates when() only between held intercepts
 * that share that id. With no held ids (interceptTargeted in match-api.ts),
 * an action takes the first declared. Under include() a route has two names,
 * its own and its local one: a navigation tries them in turn, an action
 * collects its held intercepts under both in one walk.
 */

function intercept(
  slotName: `@${string}`,
  when: InterceptEntry["when"] = [],
  routeName = "item",
): InterceptEntry {
  return { slotName, routeName, handler: null, loader: [], when };
}

/**
 * A route mounted by include(..., { name: "shop" }): its own name, then its
 * local name.
 */
const SHOP_ITEM = ["shop.item", "item"] as const;

function layout(intercepts: InterceptEntry[]): EntryData {
  return {
    shortCode: "M0L0",
    intercept: intercepts,
    layout: [],
    parent: null,
  } as unknown as EntryData;
}

function source(pathname: string): InterceptSelectorContext {
  return {
    from: { url: new URL(`http://localhost${pathname}`), params: {} },
    to: { url: new URL("http://localhost/item/1"), params: { id: "1" } },
    request: new Request("http://localhost/item/1"),
    env: {},
    segments: { path: pathname.split("/").filter(Boolean), ids: [] },
  } as unknown as InterceptSelectorContext;
}

const from = (pathname: string) =>
  vi.fn((ctx: InterceptSelectorContext) => ctx.from.url.pathname === pathname);

function select(
  entry: EntryData,
  ctx: InterceptSelectorContext | null,
  isAction: boolean,
  held?: string[],
  names: string | readonly string[] = "item",
): InterceptEntry | undefined {
  return findInterceptForRoute(
    names,
    entry,
    ctx,
    isAction,
    held && new Set(held),
  )?.intercept;
}

describe("findInterceptForRoute", () => {
  it("navigation: the first intercept whose when() passes", () => {
    const modal = intercept("@modal", [from("/list")]);
    const drawer = intercept("@drawer", [from("/other")]);
    const entry = layout([modal, drawer]);
    expect(select(entry, source("/list"), false)).toBe(modal);
    expect(select(entry, source("/other"), false)).toBe(drawer);
    expect(select(entry, source("/"), false)).toBeUndefined();
  });

  it("navigation: the held ids do not change the selection", () => {
    const modal = intercept("@modal", [from("/list")]);
    const drawer = intercept("@drawer", [from("/other")]);
    expect(
      select(layout([modal, drawer]), source("/list"), false, ["M0L0.@drawer"]),
    ).toBe(modal);
  });

  it("action: the intercept whose slot the client holds, not the first declared, when() not evaluated", () => {
    const toModal = from("/list");
    const toDrawer = from("/other");
    const modal = intercept("@modal", [toModal]);
    const drawer = intercept("@drawer", [toDrawer]);
    expect(
      select(layout([modal, drawer]), source("/other"), true, [
        "M0L0",
        "M0L0.@drawer",
      ]),
    ).toBe(drawer);
    expect(toModal).not.toHaveBeenCalled();
    expect(toDrawer).not.toHaveBeenCalled();
  });

  it("action: the held intercept stays when its when() now rejects", () => {
    const modal = intercept("@modal", [from("/list")]);
    const drawer = intercept("@drawer", [() => false]);
    expect(
      select(layout([modal, drawer]), source("/list"), true, ["M0L0.@drawer"]),
    ).toBe(drawer);
  });

  it("action: two held intercepts that share a slot are told apart by when()", () => {
    const modal = intercept("@modal", [from("/list")]);
    const sheet = intercept("@modal", [from("/other")]);
    const entry = layout([modal, sheet]);
    expect(select(entry, source("/other"), true, ["M0L0.@modal"])).toBe(sheet);
    expect(select(entry, source("/list"), true, ["M0L0.@modal"])).toBe(modal);
  });

  it("action: two held intercepts that share a slot, neither when() passing, give the first", () => {
    const modal = intercept("@modal", [from("/list")]);
    const sheet = intercept("@modal", [from("/other")]);
    expect(
      select(layout([modal, sheet]), source("/"), true, ["M0L0.@modal"]),
    ).toBe(modal);
  });

  it("action holding no slot of the route's intercepts: none", () => {
    const modal = intercept("@modal", [from("/list")]);
    const drawer = intercept("@drawer", [from("/other")]);
    expect(
      select(layout([modal, drawer]), source("/other"), true, ["M0L0"]),
    ).toBeUndefined();
  });

  it("action with no held ids: the first declared, when() not evaluated", () => {
    const toModal = from("/list");
    const modal = intercept("@modal", [toModal]);
    const drawer = intercept("@drawer", [from("/other")]);
    const entry = layout([modal, drawer]);
    expect(select(entry, source("/other"), true)).toBe(modal);
    expect(select(entry, null, true)).toBe(modal);
    expect(toModal).not.toHaveBeenCalled();
  });

  it("walks from the route's parent up: an inner layout's intercept comes first", () => {
    const outer = intercept("@outer");
    const inner = intercept("@modal");
    const root = layout([outer]);
    const child = {
      shortCode: "M0L0L0",
      intercept: [inner],
      layout: [],
      parent: root,
    } as unknown as EntryData;
    expect(select(child, source("/list"), false)).toBe(inner);
    expect(select(child, source("/list"), true, ["M0L0.@outer"])).toBe(outer);
  });

  it("navigation: the route's own name along the whole chain before its local name", () => {
    const own = intercept("@modal", [from("/other")], "shop.item");
    const local = intercept("@drawer", [from("/other")], "item");
    const child = {
      shortCode: "M0L0L0",
      intercept: [local],
      layout: [],
      parent: layout([own]),
    } as unknown as EntryData;
    expect(select(child, source("/other"), false, undefined, SHOP_ITEM)).toBe(
      own,
    );
    expect(select(child, source("/other"), false, undefined, ["item"])).toBe(
      local,
    );
  });

  it("action: one walk over both names, so a held own-name slot (a parallel() default's) does not win before the local name", () => {
    const modal = intercept("@modal", [from("/list")], "shop.item");
    const drawer = intercept("@drawer", [from("/other")], "item");
    const entry = layout([modal, drawer]);
    const held = ["M0L0", "M0L0.@modal", "M0L0.@drawer"];
    expect(select(entry, source("/other"), true, held, SHOP_ITEM)).toBe(drawer);
    expect(select(entry, source("/list"), true, held, SHOP_ITEM)).toBe(modal);
  });

  it("action: a same-slot pair split across the two names is told apart by when()", () => {
    const modal = intercept("@modal", [from("/list")], "shop.item");
    const sheet = intercept("@modal", [from("/other")], "item");
    const entry = layout([modal, sheet]);
    const held = ["M0L0.@modal"];
    expect(select(entry, source("/other"), true, held, SHOP_ITEM)).toBe(sheet);
    expect(select(entry, source("/list"), true, held, SHOP_ITEM)).toBe(modal);
    // Neither passing: the own name's first.
    expect(select(entry, source("/"), true, held, SHOP_ITEM)).toBe(modal);
  });

  it("action: a held local-name intercept alone is selected without when()", () => {
    const toModal = from("/list");
    const modal = intercept("@modal", [toModal], "shop.item");
    const drawer = intercept("@drawer", [() => false], "item");
    expect(
      select(
        layout([modal, drawer]),
        source("/list"),
        true,
        ["M0L0.@drawer"],
        SHOP_ITEM,
      ),
    ).toBe(drawer);
    expect(toModal).not.toHaveBeenCalled();
  });
});
