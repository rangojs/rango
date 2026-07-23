import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

function reverseModuleLevelTests(f: Fixture) {
  test("module-level reverse() resolves via injected NamedRoutes map", async ({
    request,
  }) => {
    const res = await request.get(f.url("/reverse-fallback-test"));
    expect(res.status()).toBe(200);

    const body = await res.json();
    const results = body;

    // These routes come from include() calls — at module load time the lazy
    // includes haven't resolved yet, so reverse() relies on the injected
    // static NamedRoutes map from the generated file.
    expect(results["blog.index"]).toBe("/blog");
    expect(results["blog.post"]).toBe("/blog/test-post");
    expect(results["search.index"]).toBe("/search");
    expect(results["middlewareTest.index"]).toBe("/middleware-test");
  });
}

test.describe("reverse-module-level", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });
  reverseModuleLevelTests(f);
});

test.describe("reverse-module-level (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });
  test.setTimeout(120000);
  reverseModuleLevelTests(f);
});
