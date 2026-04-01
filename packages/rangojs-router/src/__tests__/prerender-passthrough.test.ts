import { describe, it, expect } from "vitest";
import {
  PRERENDER_PASSTHROUGH,
  isPrerenderPassthrough,
  Passthrough,
  isPassthroughHandler,
  isPrerenderHandler,
} from "../prerender.js";

describe("PRERENDER_PASSTHROUGH sentinel", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(PRERENDER_PASSTHROUGH)).toBe(true);
  });

  it("has __brand 'prerenderPassthrough'", () => {
    expect(PRERENDER_PASSTHROUGH.__brand).toBe("prerenderPassthrough");
  });

  it("isPrerenderPassthrough returns true for the sentinel", () => {
    expect(isPrerenderPassthrough(PRERENDER_PASSTHROUGH)).toBe(true);
  });

  it("isPrerenderPassthrough returns false for non-sentinels", () => {
    expect(isPrerenderPassthrough(null)).toBe(false);
    expect(isPrerenderPassthrough(undefined)).toBe(false);
    expect(isPrerenderPassthrough("prerenderPassthrough")).toBe(false);
    expect(isPrerenderPassthrough({})).toBe(false);
    expect(isPrerenderPassthrough({ __brand: "other" })).toBe(false);
  });
});

describe("Passthrough() wrapper", () => {
  const fakePrerenderDef = {
    __brand: "prerenderHandler" as const,
    $$id: "test#Handler",
    handler: async () => null,
  };

  it("wraps a PrerenderHandlerDefinition with a live handler", () => {
    const liveHandler = async () => null;
    const result = Passthrough(fakePrerenderDef, liveHandler);
    expect(result.__brand).toBe("passthroughHandler");
    expect(result.prerenderDef).toBe(fakePrerenderDef);
    expect(result.liveHandler).toBe(liveHandler);
  });

  it("isPassthroughHandler returns true for Passthrough result", () => {
    const result = Passthrough(fakePrerenderDef, async () => null);
    expect(isPassthroughHandler(result)).toBe(true);
  });

  it("isPassthroughHandler returns false for non-passthrough values", () => {
    expect(isPassthroughHandler(null)).toBe(false);
    expect(isPassthroughHandler(undefined)).toBe(false);
    expect(isPassthroughHandler(fakePrerenderDef)).toBe(false);
    expect(isPassthroughHandler({ __brand: "other" })).toBe(false);
  });

  it("isPrerenderHandler returns false for Passthrough result", () => {
    const result = Passthrough(fakePrerenderDef, async () => null);
    expect(isPrerenderHandler(result)).toBe(false);
  });

  it("throws if first argument is not a PrerenderHandlerDefinition", () => {
    expect(() =>
      Passthrough({ __brand: "other" } as any, async () => null),
    ).toThrow("first argument must be a Prerender() definition");
  });
});

describe("ctx.passthrough() on createPrerenderContext (build-time)", () => {
  let createPrerenderContext: typeof import("../router/handler-context.js").createPrerenderContext;

  it("returns PRERENDER_PASSTHROUGH when isPassthroughRoute is true", async () => {
    ({ createPrerenderContext } = await import("../router/handler-context.js"));
    const ctx = createPrerenderContext(
      { slug: "a" },
      "/blog/a",
      {},
      "blog.post",
      undefined,
      true, // isPassthroughRoute
    );
    const result = (ctx as any).passthrough();
    expect(isPrerenderPassthrough(result)).toBe(true);
    expect(result).toBe(PRERENDER_PASSTHROUGH);
  });

  it("throws when isPassthroughRoute is false", async () => {
    ({ createPrerenderContext } = await import("../router/handler-context.js"));
    const ctx = createPrerenderContext(
      { slug: "a" },
      "/blog/a",
      {},
      "blog.post",
      undefined,
      false, // not passthrough
    );
    expect(() => (ctx as any).passthrough()).toThrow(
      "ctx.passthrough() is only available on routes wrapped with Passthrough()",
    );
  });

  it("throws when isPassthroughRoute is undefined", async () => {
    ({ createPrerenderContext } = await import("../router/handler-context.js"));
    const ctx = createPrerenderContext(
      { slug: "a" },
      "/blog/a",
      {},
      "blog.post",
    );
    expect(() => (ctx as any).passthrough()).toThrow(
      "ctx.passthrough() is only available on routes wrapped with Passthrough()",
    );
  });
});

describe("ctx.passthrough() on createHandlerContext (runtime)", () => {
  let createHandlerContext: typeof import("../router/handler-context.js").createHandlerContext;

  it("throws at runtime even when isPassthroughRoute is true", async () => {
    ({ createHandlerContext } = await import("../router/handler-context.js"));
    const ctx = createHandlerContext(
      { slug: "a" },
      new Request("http://localhost/blog/a"),
      new URLSearchParams(),
      "/blog/a",
      new URL("http://localhost/blog/a"),
      {},
      {},
      "blog.post",
      undefined,
      true, // isPassthroughRoute
    );
    expect(() => (ctx as any).passthrough()).toThrow(
      "ctx.passthrough() can only be called during build-time prerendering",
    );
  });
});
