import { describe, expect, it } from "vitest";
import { dispatch } from "@rangojs/router/testing";
import { createRouter, urls } from "@rangojs/router";
import {
  includeScopeCollisionPatterns,
  includeScopePublicPatterns,
} from "../src/pages/include-scope.js";

// Dogfood (#1104): the app's include-scope fixture (src/pages/include-scope.tsx),
// mounted as src/urls.tsx mounts it. dispatch matches through the route trie,
// as the app does in dev and production, so a route key build discovery and
// the runtime disagree on fails here, not only in e2e.
const mount = () =>
  createRouter({}).routes(
    urls(({ include }) => [
      include("/", includeScopePublicPatterns),
      include("/include-scope", includeScopeCollisionPatterns, {
        name: "includeScope",
      }),
    ]),
  );

async function page(router: ReturnType<typeof mount>, url: string) {
  const res = await dispatch(router, { request: url });
  expect(res.status, url).toBe(200);
  return ((await res.json()) as { page: string }).page;
}

describe("hidden include-scope names through dispatch", () => {
  it("serves a route behind an unnamed include nested in an unnamed include", async () => {
    expect(await page(mount(), "/nested-unnamed/login.json")).toBe("login");
  });

  it("serves same-named routes beside and behind a transparent include from their own handlers", async () => {
    const router = mount();
    expect(await page(router, "/include-scope/x.json")).toBe("x");
    expect(await page(router, "/include-scope/z.json")).toBe("z");
  });
});
