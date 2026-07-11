import { describe, expect, it } from "vitest";
import { getManualChunks } from "../utils/shared-utils.js";

describe("getManualChunks", () => {
  it.each([
    "runtime",
    "fetch",
    "queue",
    "observer",
    "policy",
    "resource-ready",
  ])(
    "leaves lazy prefetch module %s outside the eager router chunk",
    (file) => {
      expect(
        getManualChunks(
          `/repo/packages/rangojs-router/src/browser/prefetch/${file}.ts`,
        ),
      ).toBeUndefined();
    },
  );

  it("keeps the prefetch loader and cache in the eager router chunk", () => {
    expect(
      getManualChunks(
        "/repo/packages/rangojs-router/src/browser/prefetch/loader.ts",
      ),
    ).toBe("router");
    expect(
      getManualChunks(
        "/repo/node_modules/@rangojs/router/src/browser/prefetch/cache.ts",
      ),
    ).toBe("router");
  });

  it.each([
    "/repo/node_modules/@rangojs/router/src/browser/prefetch/runtime.ts?worker",
    "/repo/node_modules/.pnpm/@rangojs+router@0.1.0/node_modules/@rangojs/router/src/browser/prefetch/fetch.ts#client",
  ])("recognizes installed lazy prefetch paths", (id) => {
    expect(getManualChunks(id)).toBeUndefined();
  });
});
