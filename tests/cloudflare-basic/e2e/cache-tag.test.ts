import { expect, test, type APIRequestContext } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

// Serial: the tag tests share one cached route + the CF cache across the
// fixture server, so an invalidation in one test must not race another.
test.describe.configure({ mode: "serial" });

/**
 * Tag-based invalidation against the real CFCacheStore (Cache API L1 + KV L2).
 *
 * The CF store has no companion tag-invalidation store: updateTag() writes a
 * tag-invalidation marker into the store's OWN KV namespace, and every read
 * path compares the entry's taggedAt against that marker. This exercises that
 * end to end (dev + production), which unit tests with a KV double cannot fully
 * prove.
 */

function defineTaggedTests(f: Fixture) {
  async function ts(request: APIRequestContext, path: string): Promise<number> {
    const res = await request.get(f.url(path));
    expect(res.status()).toBe(200);
    return (await res.json()).ts;
  }

  test("cache() tags: a tagged CF entry is invalidated by updateTag", async ({
    request,
  }) => {
    const first = await ts(request, "/test/tagged-json");

    // Poll until the async (waitUntil) cache write lands -> stable ts.
    await expect
      .poll(() => ts(request, "/test/tagged-json"), { timeout: 8000 })
      .toBe(first);

    // Invalidate the tag (awaited -> KV marker written before the response).
    const inv = await request.get(f.url("/test/invalidate-tag/cf-items"));
    expect(inv.status()).toBe(200);

    // Next reads see the KV marker (taggedAt < invalidatedAt) -> fresh ts.
    await expect
      .poll(() => ts(request, "/test/tagged-json"), { timeout: 8000 })
      .not.toBe(first);

    // The fresh value must RE-CACHE, not re-execute forever (a regression that
    // permanently disabled caching for an invalidated key would keep producing a
    // new ts on every read). Poll until two consecutive reads agree (stable hit).
    await expect
      .poll(
        async () => {
          const a = await ts(request, "/test/tagged-json");
          const b = await ts(request, "/test/tagged-json");
          return a === b ? a : null;
        },
        { timeout: 8000 },
      )
      .not.toBeNull();
  });

  test("invalidating an unknown tag does not disturb a cached CF entry", async ({
    request,
  }) => {
    const first = await ts(request, "/test/tagged-json");
    await expect
      .poll(() => ts(request, "/test/tagged-json"), { timeout: 8000 })
      .toBe(first);

    const inv = await request.get(f.url("/test/invalidate-tag/no-such-cf-tag"));
    expect(inv.status()).toBe(200);

    // Still cached (same ts) — unknown tag is a safe no-op.
    expect(await ts(request, "/test/tagged-json")).toBe(first);
  });

  test("revalidateTag invalidates a tagged CF entry in the background (not awaited)", async ({
    request,
  }) => {
    const first = await ts(request, "/test/tagged-json");
    await expect
      .poll(() => ts(request, "/test/tagged-json"), { timeout: 8000 })
      .toBe(first);

    // Fire-and-forget: revalidateTag schedules invalidation via waitUntil and the
    // response returns immediately (unlike updateTag, it is not awaited).
    const rev = await request.get(f.url("/test/revalidate-tag/cf-items"));
    expect(rev.status()).toBe(200);

    // The invalidation lands in the background; poll until the next read is fresh.
    await expect
      .poll(() => ts(request, "/test/tagged-json"), { timeout: 8000 })
      .not.toBe(first);
  });

  test("invalidating one tag does not disturb an entry under a DIFFERENT tag", async ({
    request,
  }) => {
    // Prime both tagged routes (distinct tags: cf-items vs cf-items-b).
    const aFirst = await ts(request, "/test/tagged-json");
    const bFirst = await ts(request, "/test/tagged-json-b");
    await expect
      .poll(() => ts(request, "/test/tagged-json"), { timeout: 8000 })
      .toBe(aFirst);
    await expect
      .poll(() => ts(request, "/test/tagged-json-b"), { timeout: 8000 })
      .toBe(bFirst);

    // Invalidate only cf-items.
    const inv = await request.get(f.url("/test/invalidate-tag/cf-items"));
    expect(inv.status()).toBe(200);

    // cf-items entry refreshes...
    await expect
      .poll(() => ts(request, "/test/tagged-json"), { timeout: 8000 })
      .not.toBe(aFirst);
    // ...but the cf-items-b entry is untouched (per-tag markers, no over-invalidation).
    expect(await ts(request, "/test/tagged-json-b")).toBe(bFirst);
  });

  // Document-level tag invalidation (#1): /tagged-document is document-cached
  // (full-page response) AND tagged via a "use cache" + cacheTag("doc-page"), so
  // its whole-page entry must be invalidatable by updateTag, not just inner items.
  test("document cache: a tagged full-page entry is invalidated by updateTag", async ({
    request,
  }) => {
    const fetchDoc = (request2: APIRequestContext) =>
      request2.get(f.url("/tagged-document"), {
        headers: { Accept: "text/html" },
      });
    const docTs = async (): Promise<number> => {
      const res = await fetchDoc(request);
      expect(res.status()).toBe(200);
      const m = /data-doc-ts="(\d+)"/.exec(await res.text());
      if (!m) throw new Error("no data-doc-ts in /tagged-document HTML");
      return Number(m[1]);
    };
    const docStatus = async (): Promise<string | undefined> =>
      (await fetchDoc(request)).headers()["x-document-cache-status"];

    // Prime until the background document write lands -> served as a HIT.
    await expect.poll(docStatus, { timeout: 15000 }).toBe("HIT");
    const cachedTs = await docTs();
    // A second HIT returns the same cached timestamp.
    expect(await docTs()).toBe(cachedTs);

    // Invalidate the page's tag (awaited -> KV marker written before response).
    const inv = await request.get(f.url("/test/invalidate-tag/doc-page"));
    expect(inv.status()).toBe(200);

    // The full-page document entry is now invalidated: the next render is fresh
    // (new ts) — document caching is no longer silently serving the stale page.
    await expect.poll(docTs, { timeout: 15000 }).not.toBe(cachedTs);

    // The fresh page must RE-CACHE and RE-TAG (not just evict once). Poll until
    // it serves a HIT again, capture the re-cached ts, then invalidate the same
    // tag a SECOND time and assert it refreshes again — proving the re-rendered
    // document carried the tag forward (a regression that dropped the tag on
    // re-cache would make this second updateTag a silent no-op).
    await expect.poll(docStatus, { timeout: 15000 }).toBe("HIT");
    const recachedTs = await docTs();

    const inv2 = await request.get(f.url("/test/invalidate-tag/doc-page"));
    expect(inv2.status()).toBe(200);
    await expect.poll(docTs, { timeout: 15000 }).not.toBe(recachedTs);
  });

  // Pins the stream-drain barrier: /streamed-document tags itself via cacheTag
  // INSIDE a Suspense boundary, so the tag is recorded during the stream (after
  // handler settlement). If the document snapshot used the handler-settlement
  // barrier it would miss "streamed-doc" and this updateTag would be a silent
  // no-op; the full page must still invalidate.
  test("document cache: a tag set during the STREAM (Suspense) still invalidates the full page", async ({
    request,
  }) => {
    const fetchDoc = (request2: APIRequestContext) =>
      request2.get(f.url("/streamed-document"), {
        headers: { Accept: "text/html" },
      });
    const docTs = async (): Promise<number> => {
      const res = await fetchDoc(request);
      expect(res.status()).toBe(200);
      const m = /data-doc-ts="(\d+)"/.exec(await res.text());
      if (!m) throw new Error("no data-doc-ts in /streamed-document HTML");
      return Number(m[1]);
    };
    const docStatus = async (): Promise<string | undefined> =>
      (await fetchDoc(request)).headers()["x-document-cache-status"];

    await expect.poll(docStatus, { timeout: 15000 }).toBe("HIT");
    const cachedTs = await docTs();

    const inv = await request.get(f.url("/test/invalidate-tag/streamed-doc"));
    expect(inv.status()).toBe(200);
    await expect.poll(docTs, { timeout: 15000 }).not.toBe(cachedTs);
  });
}

test.describe("CF cache-tag invalidation (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  defineTaggedTests(f);
});

test.describe("CF cache-tag invalidation (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  defineTaggedTests(f);
});
