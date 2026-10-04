import { expect, test, type APIRequestContext } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

// Serial: the tests share the route's loader-cache entry and its tags.
test.describe.configure({ mode: "serial" });

/**
 * A loader with its own cache() whose body and dependency tag it (#964), on
 * Node with the memory store. Fixture: /cache-tag-test/loader-body
 * (e2e/test-app/src/urls/cache-tag.tsx). `lbt-stamp` is per run: an
 * unchanged value is a loader-cache HIT.
 */
const STAMP = /data-testid="lbt-stamp">([^<]+)</;

function defineLoaderBodyTagTests(f: Fixture): void {
  async function stamp(request: APIRequestContext): Promise<string> {
    const res = await request.get(f.url("/cache-tag-test/loader-body"), {
      headers: { Accept: "text/html" },
    });
    expect(res.status()).toBe(200);
    const m = STAMP.exec(await res.text());
    if (!m) throw new Error("no lbt-stamp in /cache-tag-test/loader-body");
    return m[1]!;
  }

  // Two consecutive reads agree once the background write has landed.
  async function cachedStamp(request: APIRequestContext): Promise<string> {
    let value = "";
    await expect
      .poll(
        async () => {
          value = await stamp(request);
          return (await stamp(request)) === value;
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
    const res = await request.get(f.url(`/cache-tag-test/invalidate/${tag}`), {
      headers: { Accept: "application/json" },
    });
    expect(res.status()).toBe(200);
  }

  for (const tag of ["loader-body-tag", "loader-dep-tag"]) {
    test(`updateTag(${tag}) refreshes the loader's cached value, and the refreshed entry carries it again`, async ({
      request,
    }) => {
      const cached = await cachedStamp(request);

      await invalidate(request, tag);
      await expect
        .poll(() => stamp(request), { timeout: 15000 })
        .not.toBe(cached);

      const recached = await cachedStamp(request);
      await invalidate(request, tag);
      await expect
        .poll(() => stamp(request), { timeout: 15000 })
        .not.toBe(recached);
    });
  }

  test("an unrelated tag leaves the loader's entry cached", async ({
    request,
  }) => {
    const cached = await cachedStamp(request);

    await invalidate(request, "no-such-loader-tag");

    expect(await stamp(request)).toBe(cached);
  });
}

test.describe("loader cache() body tags", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  defineLoaderBodyTagTests(f);
});

test.describe("loader cache() body tags (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  defineLoaderBodyTagTests(f);
});
