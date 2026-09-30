import { expect, test, type APIRequestContext } from "@playwright/test";
import { useFixture } from "./fixture";

/**
 * What a nested cache() takes from the scopes enclosing it, and namespaced
 * key() results, on CFCacheStore. Fixture: src/urls.tsx.
 *
 * - /nested-condition (issue #974): the outer condition() refuses requests
 *   carrying `x-cache-bypass: 1`. Before, only the inner scope's own
 *   condition ran, so a refused request read the inner record.
 * - /nested-tags (issue #974): the outer cache() tags `nested-outer:<probe>`.
 *   Before, the inner record carried only its own tags, so updateTag() of the
 *   outer tag left it in place.
 * - /cross-store (issue #974): the outer cache()'s store partitions by an
 *   `x-cache-locale` keyGenerator; the inner cache() writes to the app
 *   store. Before, the inner record was keyed by the default key alone, so
 *   a `de` visitor received the record an `en` request wrote.
 * - /test/raw-key* (issue #975): a key() returns a request header as is.
 *   Before, the header value `json:<host>/test/raw-key-victim?...` named the
 *   victim's default-keyed entry, so the victim served the other route's
 *   body.
 */

async function renderOf(
  request: APIRequestContext,
  url: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const res = await request.get(url, {
    headers: { Accept: "text/html", ...headers },
  });
  expect(res.status()).toBe(200);
  const rendered = /data-testid="nested-scope-render"[^>]*>([^<]*)</.exec(
    await res.text(),
  );
  expect(rendered).not.toBeNull();
  return rendered![1];
}

/** Poll `read` until two consecutive results match: the second is a HIT. */
async function untilStable(read: () => Promise<string>): Promise<string> {
  let before = await read();
  let hit: string | undefined;
  await expect
    .poll(
      async () => {
        const next = await read();
        if (next === before) hit = next;
        before = next;
        return hit !== undefined;
      },
      { timeout: 15_000, message: "Expected the record to replay" },
    )
    .toBe(true);
  return hit!;
}

async function expectOuterConditionGatesInner(
  request: APIRequestContext,
  url: (path: string) => string,
): Promise<void> {
  const page = url(
    `/nested-condition?probe=${crypto.randomUUID().slice(0, 8)}`,
  );
  const bypass = { "x-cache-bypass": "1" };
  const hit = await untilStable(() => renderOf(request, page));

  // Refused by the outer condition(): live, not the inner record.
  const live = await renderOf(request, page, bypass);
  expect(live).not.toBe(hit);
  expect(await renderOf(request, page, bypass)).not.toBe(live);
  // Nor did the refused requests write it.
  expect(await renderOf(request, page)).toBe(hit);
}

async function expectOuterTagEvictsInner(
  request: APIRequestContext,
  url: (path: string) => string,
): Promise<void> {
  const probe = crypto.randomUUID().slice(0, 8);
  const page = url(`/nested-tags?probe=${probe}`);
  const hit = await untilStable(() => renderOf(request, page));

  const res = await request.get(
    url(`/test/invalidate-tag/${encodeURIComponent(`nested-outer:${probe}`)}`),
  );
  expect(res.ok()).toBe(true);

  const fresh = await renderOf(request, page);
  expect(fresh).not.toBe(hit);
}

async function expectOuterStorePartitionsInner(
  request: APIRequestContext,
  url: (path: string) => string,
): Promise<void> {
  const page = url(`/cross-store?probe=${crypto.randomUUID().slice(0, 8)}`);
  const locale = (name: string) => ({ "x-cache-locale": name });
  const en = await untilStable(() => renderOf(request, page, locale("en")));
  expect(en).toMatch(/^en:/);

  // Another locale never reads en's inner record.
  expect(await renderOf(request, page, locale("de"))).toMatch(/^de:/);
  const de = await untilStable(() => renderOf(request, page, locale("de")));
  expect(de).toMatch(/^de:/);
  expect(await renderOf(request, page, locale("en"))).toBe(en);
}

async function expectRawKeyCannotNameVictim(
  request: APIRequestContext,
  url: (path: string) => string,
): Promise<void> {
  const probe = crypto.randomUUID().slice(0, 8);
  const host = new URL(url("/")).host;
  const victim = url(`/test/raw-key-victim?probe=${probe}`);
  const crafted = {
    "x-raw-key": `json:${host}/test/raw-key-victim?probe=${probe}`,
  };
  const readJson = async (
    target: string,
    headers: Record<string, string> = {},
  ) => (await request.get(target, { headers })).json();

  // The crafted request's own entry is written (its token replays).
  await untilStable(async () =>
    JSON.stringify(await readJson(url("/test/raw-key"), crafted)),
  );

  expect(await readJson(victim)).toMatchObject({ from: "victim" });
}

test.describe("nested cache() inherits the enclosing scopes (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });

  test("an outer condition() refusing a request bypasses the inner record", async ({
    request,
  }) => {
    await expectOuterConditionGatesInner(request, f.url);
  });

  test("updateTag() of an outer cache() tag evicts the inner record", async ({
    request,
  }) => {
    await expectOuterTagEvictsInner(request, f.url);
  });

  test("an outer cache({ store }) keyGenerator partitions the inner record", async ({
    request,
  }) => {
    await expectOuterStorePartitionsInner(request, f.url);
  });

  test("a raw key() result cannot name another route's default-keyed entry", async ({
    request,
  }) => {
    await expectRawKeyCannotNameVictim(request, f.url);
  });
});

test.describe("nested cache() inherits the enclosing scopes (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });

  test("an outer condition() refusing a request bypasses the inner record", async ({
    request,
  }) => {
    await expectOuterConditionGatesInner(request, f.url);
  });

  test("updateTag() of an outer cache() tag evicts the inner record", async ({
    request,
  }) => {
    await expectOuterTagEvictsInner(request, f.url);
  });

  test("an outer cache({ store }) keyGenerator partitions the inner record", async ({
    request,
  }) => {
    await expectOuterStorePartitionsInner(request, f.url);
  });

  test("a raw key() result cannot name another route's default-keyed entry", async ({
    request,
  }) => {
    await expectRawKeyCannotNameVictim(request, f.url);
  });
});
