import { expect, test, type APIRequestContext } from "@playwright/test";
import { useFixture } from "./fixture";

/**
 * What a nested cache() takes from the scopes enclosing it, and namespaced
 * key() results. Fixture: e2e/test-app/src/urls/cache.tsx.
 *
 * - /cache-test/nested-condition (issue #974): the outer condition() refuses
 *   requests carrying `x-cache-bypass: 1`. Before, only the inner scope's own
 *   condition ran, so a refused request read the inner record.
 * - /cache-test/nested-tags (issue #974): the outer cache() tags
 *   `nested-outer:<probe>`. Before, the inner record carried only its own
 *   tags, so updateTag() of the outer tag left it in place.
 * - /cache-test/cross-store (issue #974): the outer cache()'s store partitions by an
 *   `x-cache-locale` keyGenerator; the inner cache() writes to the app
 *   store. Before, the inner record was keyed by the default key alone, so
 *   a `de` visitor received the record an `en` request wrote.
 * - /cache-test/raw-key* (issue #975): a key() returns a request header as
 *   is. Before, a header value spelling the victim's default key
 *   (`json:<router>@<host>/cache-test/raw-key-victim?...`) named the
 *   victim's entry, so the victim served the other route's body.
 * - /cache-test/loader-key-* (issue #1009): a loader's own key() returns a
 *   request header as is. Before, a header value spelling the victim
 *   loader's default key
 *   (`loader:<victim id>:<router>@<host>/cache-test/loader-key-victim/<probe>:...`)
 *   read the victim loader's entry, and on a miss wrote over it.
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

/**
 * The router part of the app's default cache keys, `{routerId}@`, from the
 * loader-key victim page, which shows the router's id.
 */
function routerKeyPartIn(victimHtml: string): string {
  const id = /data-testid="cache-key-router-id"[^>]*>([^<]*)</.exec(
    victimHtml,
  )![1];
  return `${encodeURIComponent(id)}@`;
}

async function victimPageHtml(
  request: APIRequestContext,
  url: (path: string) => string,
): Promise<string> {
  const res = await request.get(url("/cache-test/loader-key-victim/id"), {
    headers: { Accept: "text/html" },
  });
  return res.text();
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
      { timeout: 10_000, message: "Expected the record to replay" },
    )
    .toBe(true);
  return hit!;
}

async function expectOuterConditionGatesInner(
  request: APIRequestContext,
  url: (path: string) => string,
): Promise<void> {
  const page = url(
    `/cache-test/nested-condition?probe=${crypto.randomUUID().slice(0, 8)}`,
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
  const page = url(`/cache-test/nested-tags?probe=${probe}`);
  const hit = await untilStable(() => renderOf(request, page));

  const res = await request.get(
    url(
      `/cache-tag-test/invalidate/${encodeURIComponent(`nested-outer:${probe}`)}`,
    ),
  );
  expect(res.ok()).toBe(true);

  const fresh = await renderOf(request, page);
  expect(fresh).not.toBe(hit);
}

async function expectOuterStorePartitionsInner(
  request: APIRequestContext,
  url: (path: string) => string,
): Promise<void> {
  const page = url(
    `/cache-test/cross-store?probe=${crypto.randomUUID().slice(0, 8)}`,
  );
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
  const victim = url(`/cache-test/raw-key-victim?probe=${probe}`);
  const crafted = {
    "x-raw-key": `json:${routerKeyPartIn(await victimPageHtml(request, url))}${host}/cache-test/raw-key-victim?probe=${probe}`,
  };
  const readJson = async (
    target: string,
    headers: Record<string, string> = {},
  ) => (await request.get(target, { headers })).json();

  // The crafted request's own entry is written (its run replays).
  await untilStable(async () =>
    JSON.stringify(await readJson(url(`/cache-test/raw-key`), crafted)),
  );

  expect(await readJson(victim)).toMatchObject({ from: "victim" });
}

/**
 * /cache-test/loader-key-*: the victim page at `probe`, the crafted page, and
 * the header spelling the victim loader's default key for a probe. The
 * victim's id comes from its page (a hash in build).
 */
async function loaderKeyFixture(
  request: APIRequestContext,
  url: (path: string) => string,
) {
  const host = new URL(url("/")).host;
  const victim = (probe: string) =>
    url(`/cache-test/loader-key-victim/${probe}`);
  const html = await victimPageHtml(request, url);
  const victimId = /data-testid="loader-key-victim-id"[^>]*>([^<]*)</.exec(
    html,
  )![1];
  const router = routerKeyPartIn(html);
  return {
    victim,
    crafted: url("/cache-test/loader-key-crafted"),
    victimKey: (probe: string) => ({
      "x-loader-key": `loader:${victimId}:${router}${host}/cache-test/loader-key-victim/${probe}:probe=${probe}`,
    }),
  };
}

async function expectLoaderKeyCannotReadVictim(
  request: APIRequestContext,
  url: (path: string) => string,
): Promise<void> {
  const { victim, crafted, victimKey } = await loaderKeyFixture(request, url);
  const probe = crypto.randomUUID().slice(0, 8);

  expect(await untilStable(() => renderOf(request, victim(probe)))).toMatch(
    /^victim:/,
  );
  expect(await renderOf(request, crafted, victimKey(probe))).toMatch(
    /^crafted:/,
  );
}

async function expectLoaderKeyCannotOverwriteVictim(
  request: APIRequestContext,
  url: (path: string) => string,
): Promise<void> {
  const { victim, crafted, victimKey } = await loaderKeyFixture(request, url);
  const probe = crypto.randomUUID().slice(0, 8);

  // The crafted request's own entry is written (its value replays).
  await untilStable(() => renderOf(request, crafted, victimKey(probe)));
  expect(await renderOf(request, victim(probe))).toMatch(/^victim:/);
}

test.describe("nested cache() inherits the enclosing scopes", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });

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

  test("a loader's own key() result cannot read another loader's entry", async ({
    request,
  }) => {
    await expectLoaderKeyCannotReadVictim(request, f.url);
  });

  test("a loader's own key() result cannot overwrite another loader's entry", async ({
    request,
  }) => {
    await expectLoaderKeyCannotOverwriteVictim(request, f.url);
  });
});

test.describe("nested cache() inherits the enclosing scopes (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });

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

  test("a loader's own key() result cannot read another loader's entry", async ({
    request,
  }) => {
    await expectLoaderKeyCannotReadVictim(request, f.url);
  });

  test("a loader's own key() result cannot overwrite another loader's entry", async ({
    request,
  }) => {
    await expectLoaderKeyCannotOverwriteVictim(request, f.url);
  });
});
