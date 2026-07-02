import { describe, expect, it } from "vitest";
import { collectHandle, runLoader } from "@rangojs/router/testing";
import { ManifestPricesLoader, RenderedProducts } from "../src/shared.js";

// Userland pinning of the shell-manifest pattern (skills/shell-manifest)
// through the public testing primitives. The contract under test: the loader
// prices EXACTLY the ids the shell pushed — never a re-derived list — so the
// dynamic holes cannot desync from a (possibly stale) cached shell. The
// replayed handle value is seeded here by reference (runLoader's documented
// barrier mock); the real push -> store -> replay -> barrier wiring is
// cache-path behavior covered at the e2e tier.
describe("shell-manifest: ManifestPricesLoader", () => {
  it("prices exactly the replayed ids, nothing more", async () => {
    const data = await runLoader(ManifestPricesLoader, {
      rendered: true,
      handles: [[RenderedProducts, ["1", "2"]]],
    });
    expect(data.prices).toEqual({ "1": 19, "2": 29 });
  });

  it("keeps an unknown replayed id as an explicit zero-price hole", async () => {
    const data = await runLoader(ManifestPricesLoader, {
      rendered: true,
      handles: [[RenderedProducts, ["999"]]],
    });
    expect(data.prices).toEqual({ "999": 0 });
  });

  it("rejects without the render barrier (ctx.rendered() contract)", async () => {
    await expect(runLoader(ManifestPricesLoader, {})).rejects.toThrow(
      /rendered/,
    );
  });

  it("RenderedProducts collect flattens per-segment pushes in segment order", () => {
    expect(collectHandle(RenderedProducts, [["1", "2"], [], ["3"]])).toEqual([
      "1",
      "2",
      "3",
    ]);
  });
});
