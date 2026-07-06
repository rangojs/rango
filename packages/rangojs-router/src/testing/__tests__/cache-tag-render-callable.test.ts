import { describe, it, expect } from "vitest";
import {
  createTestRequestContext,
  runWithRequestContext,
  runInRequestContext,
} from "../index.js";
import { cacheTag } from "../../cache/cache-tag.js";

// #648: cacheTag() is render-callable. This is the DOGFOOD proof — the feature is
// reachable through the PUBLIC testing primitives a consumer gets from
// "@rangojs/router/testing" (createTestRequestContext / runWithRequestContext /
// runInRequestContext), not a private harness. A server component or handler
// calling cacheTag() with no "use cache" scope records onto the request's
// document tag set (ctx._requestTags) — the same set the PPR shell capture and
// the document cache collect — so revalidateTag() can evict the shell/document.
//
// The testing context is built by the SAME production createRequestContext, which
// seeds _requestTags; that is exactly why the render-callable form works here
// without any stub. If it were NOT seeded, cacheTag() would fall through to its
// throw, so these tests also pin that the primitive carries production wiring.
describe("cacheTag() render-callable through the testing primitives (#648)", () => {
  it("records the tag onto the request document set (createTestRequestContext inspection)", () => {
    const { ctx } = createTestRequestContext();
    runWithRequestContext(ctx, () => {
      // No "use cache" wraps this call — before #648 it threw outside a scope.
      cacheTag("campaign:spring", "nav");
    });
    // The @internal request-scoped tag set is the honest inspection seam at the
    // unit layer (a consumer observes the effect as a revalidateTag eviction).
    expect([...ctx._requestTags]).toEqual(["campaign:spring", "nav"]);
  });

  it("is reachable inside runInRequestContext (the async render seam)", async () => {
    const { result } = await runInRequestContext((ctx) => {
      cacheTag("live");
      return [...ctx._requestTags];
    });
    expect(result).toEqual(["live"]);
  });

  it("normalizes and drops empty tags in the render-callable form", () => {
    const { ctx } = createTestRequestContext();
    runWithRequestContext(ctx, () => {
      cacheTag(" products ", "", "   ");
    });
    expect([...ctx._requestTags]).toEqual(["products"]);
  });
});
