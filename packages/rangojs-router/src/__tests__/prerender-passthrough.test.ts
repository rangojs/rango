import { describe, it, expect } from "vitest";
import { PRERENDER_PASSTHROUGH, isPrerenderPassthrough } from "../prerender.js";

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
      "ctx.passthrough() is only available on routes declared with { passthrough: true }",
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
      "ctx.passthrough() is only available on routes declared with { passthrough: true }",
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
