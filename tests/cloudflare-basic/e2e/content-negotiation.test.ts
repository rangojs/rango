import { expect, test, type APIResponse } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

// The negotiation contract is pinned through dispatch and serveShellRequest on
// the app's own routes in test/content-negotiation.rsc-test.tsx. This smoke
// keeps what a unit suite cannot see: workerd serving both pipelines of a
// negotiated URL from the route trie the build emits, and the real SSR
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
  test("a negotiated URL serves each pipeline through workerd", async ({
    request,
  }) => {
    // A cold dev server can fail a route's first request while Vite
    // transforms it.
    await expect(async () => {
      // JSON defined first: */* gets the JSON variant.
      const json = await request.get(f.url("/test/negotiate"), {
        headers: { Accept: "*/*" },
      });
      expect(json.status()).toBe(200);
      expect(json.headers()["content-type"]).toContain("application/json");
      expect(await json.json()).toEqual({ format: "json", negotiated: true });
      expectVaryAcceptOnce(json);

      const doc = await request.get(f.url("/test/negotiate"), {
        headers: { Accept: "text/html,application/xhtml+xml" },
      });
      expect(doc.status()).toBe(200);
      expect(doc.headers()["content-type"]).toContain("text/html");
      expect(await doc.text()).toContain("HTML version");
      expectVaryAcceptOnce(doc);

      // A wildcard leaf's variant keeps its param.
      const wild = await request.get(f.url("/test/negotiate-wild/deep/path"), {
        headers: { Accept: "application/json" },
      });
      expect(wild.status()).toBe(200);
      expect(await wild.json()).toEqual({
        format: "json",
        wildcard: "deep/path",
      });
      expectVaryAcceptOnce(wild);
    }).toPass({ timeout: 10_000 });
  });
}

test.describe("content negotiation (dev)", () => {
  negotiationSmoke(useFixture({ root: ".", mode: "dev" }));
});

test.describe("content negotiation (production)", () => {
  negotiationSmoke(useFixture({ root: ".", mode: "build" }));
});
