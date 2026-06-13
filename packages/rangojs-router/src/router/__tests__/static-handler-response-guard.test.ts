import { describe, it, expect } from "vitest";
import { renderStaticSegment } from "../prerender-match.js";

// A Static() handler must return a ReactNode. If it returns a Response (e.g. an
// accidental redirect()), the static build path would serialize a corrupt
// artifact. renderStaticSegment guards against this and throws loudly.
describe("renderStaticSegment Response guard", () => {
  it("throws a TypeError when a static handler returns a Response", async () => {
    await expect(
      renderStaticSegment(
        async () => new Response("redirect", { status: 302 }),
        "L0",
        {},
        "test.route",
      ),
    ).rejects.toThrow(/Static handler "test\.route" returned a Response/);
  });
});
