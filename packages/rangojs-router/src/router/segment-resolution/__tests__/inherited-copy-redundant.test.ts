/**
 * inheritedCopyRedundant (revalidation.ts): whether a route's loader copies
 * inherited into a child layout with parallel slots are redundant. It reads
 * the route entry as the DSL left it, so it answers the same on a document
 * and on partials (rango-t156). The end-to-end decision, through the DSL and
 * buildMatchResult on every request kind, is pinned by
 * src/testing/__tests__/inherited-loader-copy.rsc-test.tsx.
 */
import { describe, expect, it } from "vitest";
import type { EntryData } from "../../../server/context.js";
import { inheritedCopyRedundant } from "../revalidation.js";

function route(fields: Partial<EntryData>): EntryData {
  return {
    id: "page",
    shortCode: "R0",
    type: "route",
    ...fields,
  } as EntryData;
}

describe("inheritedCopyRedundant", () => {
  it.each<[string, boolean, Record<string, unknown>]>([
    ["no loading()", true, {}],
    ["loading(false)", true, { loading: false }],
    ["loading(null)", true, { loading: null }],
    ["loading(fallback)", false, { loading: "Spinner" }],
    [
      "loading(fallback, { ssr: false }) on a navigation",
      false,
      { loading: "Spinner", loadingSsr: false },
    ],
    [
      "loading(fallback, { ssr: false }) on a document",
      false,
      { loading: false, loadingSsr: false },
    ],
  ])("%s: redundant %s", (_label, redundant, fields) => {
    expect(inheritedCopyRedundant(route(fields as Partial<EntryData>))).toBe(
      redundant,
    );
  });
});
