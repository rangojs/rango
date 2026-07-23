import { describe, it, expect, afterEach } from "vitest";
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

// In production, loader ids are hashed ("<hash>#ExportName"). The dev fallback
// that path-imports `/${idBeforeHash}` would run import("/<hash>") for an id
// that is missing from both the in-memory registry and the lazy manifest. The
// hash is not a real module, so that import throws "No such module <hash>" and
// the _rsc_loader endpoint returns a misleading 500 instead of a clean 404.
// The fallback must be skipped in production so an unknown loader resolves to
// undefined (-> 404). This was the symptom seen on custom worker entries whose
// loader manifest was missing entirely (see version-injector).
describe("getLoaderLazy — dev fallback is dev-only", () => {
  const prevNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = prevNodeEnv;
  });

  it("does not path-import a hashed id in production (returns undefined, not a throw)", async () => {
    process.env.NODE_ENV = "production";
    setLoaderImports({});
    await expect(
      getLoaderLazy("deadbeef#NonexistentLoader"),
    ).resolves.toBeUndefined();
  });

  it("attempts the path-import fallback for a hashed id outside production", async () => {
    process.env.NODE_ENV = "development";
    setLoaderImports({});
    // The id parses to file path "deadbeef", which does not resolve; in dev the
    // fallback runs and the import rejection propagates (a real server error),
    // exactly as it would for a broken loader module during local development.
    await expect(getLoaderLazy("deadbeef#NonexistentLoader")).rejects.toThrow();
  });
});
