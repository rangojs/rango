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

describe("boundary resolution: a walk that starts at an orphan", () => {
  // An orphan's parent is null; the walk continues at orphanOwner, the entry
  // whose layout[] holds it (issue #898).
  it("reaches the owner's ancestors through orphanOwner", () => {
    const eb = createElement("div", null, "root-error");
    const nb = createElement("div", null, "root-notfound");
    const root = entry({ errorBoundary: [eb], notFoundBoundary: [nb] });
    const owner = entry({ parent: root });
    const orphan = entry({ orphanOwner: owner });
    owner.layout.push(orphan);
    expect(findNearestErrorBoundary(orphan)).toBe(eb);
    expect(findNearestNotFoundBoundary(orphan)).toBe(nb);
  });

  it("an orphan's own boundary wins over its owner's", () => {
    const own = createElement("div", null, "own");
    const rootEb = createElement("div", null, "root");
    const owner = entry({ errorBoundary: [rootEb] });
    const orphan = entry({ errorBoundary: [own], orphanOwner: owner });
    owner.layout.push(orphan);
    expect(findNearestErrorBoundary(orphan)).toBe(own);
  });

  it("an entry with neither parent nor orphanOwner falls back to the default", () => {
    const fallback = createElement("div", null, "default");
    expect(findNearestErrorBoundary(entry({}), fallback)).toBe(fallback);
    expect(findNearestNotFoundBoundary(entry({}))).toBeNull();
  });
});
