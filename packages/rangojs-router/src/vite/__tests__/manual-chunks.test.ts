import { describe, expect, it } from "vitest";
import { getManualChunks } from "../utils/shared-utils.js";

describe("getManualChunks", () => {
  // Includes the modules reachable only via loader.ts's dynamic import:
  // splitting them out recreates the document -> router -> runtime request
  // waterfall (see the getManualChunks JSDoc).
  it.each([
    "runtime",
    "fetch",
    "queue",
    "observer",
    "policy",
    "resource-ready",
    "loader",
    "cache",
  ])("keeps prefetch module %s in the eager router chunk", (file) => {
    expect(
      getManualChunks(
        `/repo/packages/rangojs-router/src/browser/prefetch/${file}.ts`,
      ),
    ).toBe("router");
  });

  it.each([
    "/repo/node_modules/@rangojs/router/src/browser/prefetch/runtime.ts?worker",
    "/repo/node_modules/.pnpm/@rangojs+router@0.1.0/node_modules/@rangojs/router/src/browser/prefetch/fetch.ts#client",
  ])("keeps installed prefetch paths in the router chunk", (id) => {
    expect(getManualChunks(id)).toBe("router");
  });
});
