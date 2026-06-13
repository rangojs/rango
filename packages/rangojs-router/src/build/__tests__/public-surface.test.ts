import { describe, it, expect } from "vitest";
import * as buildPublic from "../index.js";

// Pins the #569.6 decision: the realm-crossing trie/fallback-ref builders are
// pipeline internals, consumed via direct source import (route-trie.js /
// collect-fallback-refs.js) by discovery + the runtime RSC realm. They MUST
// NOT leak back onto the public ./build barrel where a consumer could mistake
// them for intended API.
describe("@rangojs/router/build public surface", () => {
  it("does not re-export trie/fallback-ref pipeline internals", () => {
    expect(buildPublic).not.toHaveProperty("buildRouteTrie");
    expect(buildPublic).not.toHaveProperty("buildPerRouterTrie");
    expect(buildPublic).not.toHaveProperty("collectFallbackClientRefs");
  });

  it("keeps the documented public generators exported", () => {
    expect(buildPublic).toHaveProperty("generateManifest");
    expect(buildPublic).toHaveProperty("generateManifestFull");
    expect(buildPublic).toHaveProperty("generateManifestCode");
    expect(buildPublic).toHaveProperty("hashParams");
    expect(buildPublic).toHaveProperty("createScanFilter");
  });
});
