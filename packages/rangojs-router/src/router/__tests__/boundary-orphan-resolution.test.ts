import { describe, it, expect } from "vitest";
import { createElement } from "react";
import type { EntryData } from "../../server/context.js";
import {
  findNearestErrorBoundary,
  findNearestNotFoundBoundary,
} from "../error-handling.js";

// Minimal EntryData stub exposing only the fields the boundary finders read.
function entry(over: Partial<EntryData>): EntryData {
  return {
    errorBoundary: [],
    notFoundBoundary: [],
    layout: [],
    parent: null,
    ...over,
  } as unknown as EntryData;
}

describe("boundary resolution: orphan-layout siblings", () => {
  // Baseline: errorBoundary already scans orphan-layout siblings.
  it("finds an error boundary hosted on an orphan-layout sibling", () => {
    const eb = createElement("div", null, "error");
    const orphan = entry({ errorBoundary: [eb] });
    const grandparent = entry({ layout: [orphan] });
    const route = entry({ parent: grandparent });
    expect(findNearestErrorBoundary(route)).toBe(eb);
  });

  // notFoundBoundary must resolve symmetrically: it attaches identically to
  // errorBoundary, so an orphan-hosted notFound boundary must be found too.
  it("finds a notFound boundary hosted on an orphan-layout sibling (parity with errorBoundary)", () => {
    const nb = createElement("div", null, "notfound");
    const orphan = entry({ notFoundBoundary: [nb] });
    const grandparent = entry({ layout: [orphan] });
    const route = entry({ parent: grandparent });
    expect(findNearestNotFoundBoundary(route)).toBe(nb);
  });
});
