import { describe, it, expect } from "vitest";
import { Prerender } from "../prerender.js";

// A whole-app router that uses Prerender() must be importable in a bare test so
// dispatch / assertGeneratedRoutesMatch can run against it. The Vite plugin
// injects Prerender's $$id at build; in a bare test it is absent, so Prerender
// assigns a process-stable runtime fallback id (mirroring createHandle /
// createLoader). The dev-throw is preserved. The fallback is provably inert in
// production: prerender storage/lookup keys on routeName + paramHash, never $$id.
describe("Prerender bare-test $$id fallback", () => {
  it("constructs without a plugin-injected $$id (NODE_ENV != development)", () => {
    const def = Prerender(() => null);
    expect(def.__brand).toBe("prerenderHandler");
    expect(def.$$id).toMatch(/^__rango_runtime_prerender_\d+$/);
  });

  it("assigns a distinct id per call (process-stable counter)", () => {
    const a = Prerender(() => null);
    const b = Prerender(() => null);
    expect(a.$$id).not.toBe(b.$$id);
  });

  it("still throws in development for a missing id (dev-throw preserved)", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      expect(() => Prerender(() => null)).toThrow(/missing \$\$id/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
