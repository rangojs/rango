import { expect, test, type APIRequestContext } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

// Serial: the tests share the route's loader-cache entry and its tags.
test.describe.configure({ mode: "serial" });

/**
 * A loader with its own cache() whose body and dependency tag it (#964),
 * against the real CFCacheStore. Fixture: /loader-cache-tag (urls.tsx).
 * updateTag() of either tag refreshes the value; before, the entry kept
 * serving until its ttl.
 */
function defineLoaderBodyTagTests(f: Fixture) {
  async function loadedAt(request: APIRequestContext): Promise<string> {
    const res = await request.get(f.url("/loader-cache-tag"), {
      headers: { Accept: "text/html" },
    });
    expect(res.status()).toBe(200);
    const m = /data-testid="lct-loaded-at"[^>]*>([^<]+)</.exec(
      await res.text(),
    );
    if (!m) throw new Error("no lct-loaded-at in /loader-cache-tag HTML");
    return m[1]!;
  }

  // Two consecutive reads agree once the background write has landed.
  async function cachedValue(request: APIRequestContext): Promise<string> {
    let value = "";
    await expect
      .poll(
        async () => {
          value = await loadedAt(request);
          return (await loadedAt(request)) === value;
        },
        { timeout: 15000, message: "expected a loader-cache HIT" },
      )
      .toBe(true);
    return value;
  }

  async function invalidate(
    request: APIRequestContext,
    tag: string,
  ): Promise<void> {
    const res = await request.get(f.url(`/test/invalidate-tag/${tag}`));
    expect(res.status()).toBe(200);
  }

  for (const tag of ["loader-body-tag", "loader-dep-tag"]) {
    test(`updateTag(${tag}) refreshes the loader's cached value, and the refreshed entry carries it again`, async ({
      request,
    }) => {
      const cached = await cachedValue(request);

      await invalidate(request, tag);
      await expect
        .poll(() => loadedAt(request), { timeout: 15000 })
        .not.toBe(cached);

      const recached = await cachedValue(request);
      await invalidate(request, tag);
      await expect
        .poll(() => loadedAt(request), { timeout: 15000 })
        .not.toBe(recached);
    });
  }

  test("an unrelated tag leaves the loader's entry cached", async ({
    request,
  }) => {
    const cached = await cachedValue(request);

    await invalidate(request, "no-such-loader-tag");

    expect(await loadedAt(request)).toBe(cached);
  });
}

test.describe("loader cache() body tags (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  defineLoaderBodyTagTests(f);
});

test.describe("loader cache() body tags (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  defineLoaderBodyTagTests(f);
});
