import { describe, it, expect } from "vitest";
import {
  resolveHandlerUse,
  validateHandlerUseItems,
  mergeHandlerUse,
} from "../route-definition/resolve-handler-use.js";

// ---------------------------------------------------------------------------
// resolveHandlerUse
// ---------------------------------------------------------------------------

describe("resolveHandlerUse", () => {
  it("returns undefined for null/undefined", () => {
    expect(resolveHandlerUse(null)).toBeUndefined();
    expect(resolveHandlerUse(undefined)).toBeUndefined();
  });

  it("returns undefined for ReactNode (string)", () => {
    expect(resolveHandlerUse("hello")).toBeUndefined();
  });

  it("returns undefined for ReactNode (JSX element)", () => {
    expect(resolveHandlerUse(<div>test</div>)).toBeUndefined();
  });

  it("returns undefined for a plain function without .use", () => {
    const handler = () => <div />;
    expect(resolveHandlerUse(handler)).toBeUndefined();
  });

  it("returns .use from a plain handler function", () => {
    const useFn = () => [];
    const handler = Object.assign(() => <div />, { use: useFn });
    expect(resolveHandlerUse(handler)).toBe(useFn);
  });

  it("returns .use from PrerenderHandlerDefinition", () => {
    const useFn = () => [];
    const def = {
      __brand: "prerenderHandler" as const,
      $$id: "test",
      handler: () => <div />,
      use: useFn,
    };
    expect(resolveHandlerUse(def)).toBe(useFn);
  });

  it("returns undefined from PrerenderHandlerDefinition without .use", () => {
    const def = {
      __brand: "prerenderHandler" as const,
      $$id: "test",
      handler: () => <div />,
    };
    expect(resolveHandlerUse(def)).toBeUndefined();
  });

  it("returns .use from PassthroughHandlerDefinition", () => {
    const useFn = () => [];
    const def = {
      __brand: "passthroughHandler" as const,
      prerenderDef: {
        __brand: "prerenderHandler" as const,
        $$id: "test",
        handler: () => <div />,
      },
      liveHandler: () => <div />,
      use: useFn,
    };
    expect(resolveHandlerUse(def)).toBe(useFn);
  });

  it("returns .use from StaticHandlerDefinition", () => {
    const useFn = () => [];
    const def = {
      __brand: "staticHandler" as const,
      $$id: "test",
      handler: () => <div />,
      use: useFn,
    };
    expect(resolveHandlerUse(def)).toBe(useFn);
  });
});

// ---------------------------------------------------------------------------
// validateHandlerUseItems
// ---------------------------------------------------------------------------

describe("validateHandlerUseItems", () => {
  const makeItem = (type: string) => ({ type, name: `$test` }) as any;

  it("passes valid items for path mount", () => {
    expect(() =>
      validateHandlerUseItems(
        [makeItem("loader"), makeItem("middleware"), makeItem("loading")],
        "path",
      ),
    ).not.toThrow();
  });

  it("passes valid items for parallel mount", () => {
    expect(() =>
      validateHandlerUseItems(
        [makeItem("loader"), makeItem("revalidate"), makeItem("loading")],
        "parallel",
      ),
    ).not.toThrow();
  });

  it("throws for middleware in parallel mount", () => {
    expect(() =>
      validateHandlerUseItems([makeItem("middleware")], "parallel"),
    ).toThrow(/handler\.use\(\) returned middleware\(\).*parallel\(\)/);
  });

  it("throws for route in path mount", () => {
    expect(() => validateHandlerUseItems([makeItem("route")], "path")).toThrow(
      /handler\.use\(\) returned route\(\).*path\(\)/,
    );
  });

  it("passes everything for layout mount", () => {
    expect(() =>
      validateHandlerUseItems(
        [
          makeItem("route"),
          makeItem("layout"),
          makeItem("middleware"),
          makeItem("include"),
        ],
        "layout",
      ),
    ).not.toThrow();
  });

  it("passes valid items for intercept mount", () => {
    expect(() =>
      validateHandlerUseItems(
        [
          makeItem("middleware"),
          makeItem("loader"),
          makeItem("when"),
          makeItem("layout"),
        ],
        "intercept",
      ),
    ).not.toThrow();
  });

  it("throws for cache in intercept mount", () => {
    expect(() =>
      validateHandlerUseItems([makeItem("cache")], "intercept"),
    ).toThrow(/handler\.use\(\) returned cache\(\).*intercept\(\)/);
  });

  it("passes middleware + cache for response mount", () => {
    expect(() =>
      validateHandlerUseItems(
        [makeItem("middleware"), makeItem("cache")],
        "response",
      ),
    ).not.toThrow();
  });

  it("throws for loader in response mount", () => {
    expect(() =>
      validateHandlerUseItems([makeItem("loader")], "response"),
    ).toThrow(/handler\.use\(\) returned loader\(\).*response\(\)/);
  });

  it("throws for layout in response mount", () => {
    expect(() =>
      validateHandlerUseItems([makeItem("layout")], "response"),
    ).toThrow(/handler\.use\(\) returned layout\(\).*response\(\)/);
  });

  it("skips null/undefined items", () => {
    expect(() =>
      validateHandlerUseItems([null as any, undefined as any], "path"),
    ).not.toThrow();
  });

  it("does nothing for unknown mount site", () => {
    expect(() =>
      validateHandlerUseItems([makeItem("anything")], "unknown"),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// mergeHandlerUse
// ---------------------------------------------------------------------------

describe("mergeHandlerUse", () => {
  it("returns undefined when both are absent", () => {
    expect(mergeHandlerUse(undefined, undefined, "path")).toBeUndefined();
  });

  it("returns explicit use when no handler.use", () => {
    const explicitUse = () => [{ type: "loader" }];
    const result = mergeHandlerUse(undefined, explicitUse, "path");
    expect(result).toBe(explicitUse);
  });

  it("returns wrapped handler.use with validation when no explicit use", () => {
    const items = [{ type: "loader", name: "$test" }];
    const handlerUse = () => items;
    const merged = mergeHandlerUse(handlerUse, undefined, "path");
    expect(merged).not.toBeUndefined();
    expect(merged!()).toEqual(items);
  });

  it("handler.use only — validates items", () => {
    const handlerUse = () => [{ type: "middleware", name: "$test" }];
    const merged = mergeHandlerUse(handlerUse, undefined, "parallel");
    expect(() => merged!()).toThrow(/handler\.use\(\)/);
  });

  it("merges both with handler.use items first", () => {
    const hItem = { type: "loader", name: "$h" };
    const eItem = { type: "loading", name: "$e" };
    const handlerUse = () => [hItem];
    const explicitUse = () => [eItem];
    const merged = mergeHandlerUse(handlerUse, explicitUse, "path");
    expect(merged!()).toEqual([hItem, eItem]);
  });

  it("validates handler.use items even when merging with explicit", () => {
    const handlerUse = () => [{ type: "middleware", name: "$h" }];
    const explicitUse = () => [{ type: "loader", name: "$e" }];
    const merged = mergeHandlerUse(handlerUse, explicitUse, "parallel");
    expect(() => merged!()).toThrow(/handler\.use\(\)/);
  });

  it("flattens nested arrays from handler.use", () => {
    const handlerUse = () => [[{ type: "loader", name: "$h" }]];
    const merged = mergeHandlerUse(handlerUse, undefined, "path");
    expect(merged!()).toEqual([{ type: "loader", name: "$h" }]);
  });
});
