import { describe, expect, it } from "vitest";
import { interceptRecordKey } from "../intercept-resolution.js";
import type { EntryData, InterceptEntry } from "../../server/context.js";

/**
 * interceptRecordKey names the intercept a match selected in its cache()
 * record key: the slot id, `~`, and its position among the intercepts its
 * entry declares for the same slot and target route.
 */

function intercept(slotName: `@${string}`, routeName: string): InterceptEntry {
  return { slotName, routeName, handler: null, loader: [], when: [] };
}

function entry(intercepts: InterceptEntry[]): EntryData {
  return { shortCode: "M0L0", intercept: intercepts } as unknown as EntryData;
}

function keyOf(declared: InterceptEntry[], selected: InterceptEntry): string {
  return interceptRecordKey({ intercept: selected, entry: entry(declared) })!;
}

describe("interceptRecordKey", () => {
  it("is undefined when the match selected no intercept", () => {
    expect(interceptRecordKey(null)).toBeUndefined();
  });

  it("numbers the intercepts that fill one slot for one route apart", () => {
    const modal = intercept("@modal", "item");
    const sheet = intercept("@modal", "item");
    const declared = [modal, sheet];
    expect(keyOf(declared, modal)).toBe("M0L0.@modal~0");
    expect(keyOf(declared, sheet)).toBe("M0L0.@modal~1");
  });

  it("keeps the slot id apart for intercepts in other slots", () => {
    const modal = intercept("@modal", "item");
    const drawer = intercept("@drawer", "item");
    const declared = [modal, drawer];
    expect(keyOf(declared, modal)).toBe("M0L0.@modal~0");
    expect(keyOf(declared, drawer)).toBe("M0L0.@drawer~0");
  });

  it("is not renumbered by an intercept declared for another slot or route", () => {
    const modal = intercept("@modal", "item");
    const sheet = intercept("@modal", "item");
    const before = [modal, sheet].map((selected) =>
      keyOf([modal, sheet], selected),
    );
    const declared = [
      intercept("@modal", "cart"),
      modal,
      intercept("@drawer", "item"),
      sheet,
    ];
    expect([modal, sheet].map((selected) => keyOf(declared, selected))).toEqual(
      before,
    );
  });

  it("holds no character a URL treats as a delimiter", () => {
    const modal = intercept("@modal", "item");
    expect(keyOf([modal], modal)).not.toMatch(/[#?/]/);
  });
});
