import { describe, it, expect } from "vitest";
import { getLoaderLazy, setLoaderImports } from "../loader-registry.js";

// H1: getLoaderLazy must distinguish "never registered" (undefined -> 404)
// from "module exists but import threw" (rethrow -> 500 + onError). A lazy
// import that rejects is a real server breakage, not a not-found.
describe("getLoaderLazy — module load error (H1)", () => {
  it("rethrows when a registered lazy import throws (does not swallow to undefined)", async () => {
    setLoaderImports({
      "broken-loader": () => Promise.reject(new Error("syntax error in dev")),
    });

    await expect(getLoaderLazy("broken-loader")).rejects.toThrow(
      "syntax error in dev",
    );
  });

  it("still returns undefined for a genuinely unregistered id (404 case preserved)", async () => {
    // No lazy import and no hash-id fallback path -> genuine not-found.
    setLoaderImports({});
    await expect(getLoaderLazy("never-registered-id")).resolves.toBeUndefined();
  });
});
