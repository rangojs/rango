import { describe, expect, it } from "vitest";
import { dispatch } from "@rangojs/router/testing";
import { router } from "../src/router.js";

// Mini's full router imports in a bare test (no Prerender), and dispatch accepts
// the public router type with no cast. Mini is RSC-heavy, so dispatch's role here
// is the non-render edges: unmatched -> 404, and an RSC route -> the clear
// "does not render RSC routes" directive.
describe("dispatch against the full mini router", () => {
  it("returns 404 for an unmatched path (mini has no catch-all)", async () => {
    const res = await dispatch(router, { request: "/no/such/route" });
    expect(res.status).toBe(404);
  });

  it("throws the clear directive for an RSC (component) route", async () => {
    await expect(dispatch(router, { request: "/counter" })).rejects.toThrow(
      /does not render RSC routes/,
    );
  });

  it("throws the clear directive for the home RSC route", async () => {
    await expect(dispatch(router, { request: "/" })).rejects.toThrow(
      /does not render RSC routes/,
    );
  });
});
