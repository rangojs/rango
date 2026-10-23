import test, { expect, type APIResponse } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

// The negotiation contract (Accept ranking, definition order, the document or
// flight representation, variant middleware, Vary) is pinned through dispatch
// and serveShellRequest in
// src/testing/__tests__/content-negotiation.rsc-test.tsx. This smoke keeps
// what a unit suite cannot see: the route trie the build emits (each URL's
// variant route keys and which route was defined first) and the real SSR
// document.

// D6: a negotiated response carries `Accept` in Vary exactly once.
function expectVaryAcceptOnce(res: APIResponse): void {
  const acceptTokens = (res.headers()["vary"] ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token === "accept");
  expect(acceptTokens).toEqual(["accept"]);
}

function negotiationSmoke(f: Fixture): void {
  test("each route of a negotiated URL answers through the route trie", async ({
    request,
  }) => {
    // A cold dev server can fail a route's first request while Vite
    // transforms it.
    await expect(async () => {
      // RSC defined first: */* gets the HTML document.
      const doc = await request.get(f.url("/negotiate-test"), {
        headers: { Accept: "*/*" },
      });
      expect(doc.status()).toBe(200);
      expect(doc.headers()["content-type"]).toContain("text/html");
      expect(await doc.text()).toContain("Negotiate Test RSC");
      expectVaryAcceptOnce(doc);

      // The third route on the same URL, by its variant route key.
      const md = await request.get(f.url("/negotiate-test"), {
        headers: { Accept: "text/markdown" },
      });
      expect(md.status()).toBe(200);
      expect(md.headers()["content-type"]).toContain("text/markdown");
      expect(await md.text()).toContain("# Negotiate Test MD");
      expectVaryAcceptOnce(md);

      // JSON defined first: */* gets the JSON variant.
      const json = await request.get(f.url("/negotiate-test-json-first"), {
        headers: { Accept: "*/*" },
      });
      expect(json.status()).toBe(200);
      expect(json.headers()["content-type"]).toContain("application/json");
      expect(await json.json()).toEqual({ source: "json" });
      expectVaryAcceptOnce(json);
    }).toPass({ timeout: 10_000 });
  });
}

test.describe("content-negotiation", () => {
  negotiationSmoke(useFixture({ root: "./e2e/test-app", mode: "dev" }));
});

test.describe("content-negotiation (production)", () => {
  negotiationSmoke(useFixture({ root: "./e2e/test-app", mode: "build" }));
});
