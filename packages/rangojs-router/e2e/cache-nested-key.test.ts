import { expect, test, type APIRequestContext } from "@playwright/test";
import { useFixture } from "./fixture";

/**
 * A cache() nested in a keyed cache() keys its records within the enclosing
 * key() partition (issue #970). Fixture: e2e/test-app/src/urls/cache.tsx
 * (/cache-test/nested-key*): the outer key() reads the x-cache-tier header;
 * the page renders the tier it served and a run count a HIT replays
 * unchanged. Before, the inner scope keyed the record alone, so a silver
 * visitor received gold's cached page. The outer key() names no route, and
 * a sibling route under the same inner cache() keeps its own record.
 */

async function renderOf(
  request: APIRequestContext,
  url: string,
  tier: string,
): Promise<string> {
  const res = await request.get(url, {
    headers: { Accept: "text/html", "x-cache-tier": tier },
  });
  expect(res.status()).toBe(200);
  const rendered = /data-testid="nested-key-render"[^>]*>([^<]*)</.exec(
    await res.text(),
  );
  expect(rendered).not.toBeNull();
  return rendered![1];
}

/** Render until two consecutive responses match: the second is a HIT. */
async function untilHit(
  request: APIRequestContext,
  url: string,
  tier: string,
): Promise<string> {
  let before = await renderOf(request, url, tier);
  let hit: string | undefined;
  await expect
    .poll(
      async () => {
        const next = await renderOf(request, url, tier);
        if (next === before) hit = next;
        before = next;
        return hit !== undefined;
      },
      { timeout: 10_000, message: `Expected ${tier} to replay its record` },
    )
    .toBe(true);
  return hit!;
}

/** Gold and silver each replay only their own record; returns gold's. */
async function expectTiersKeepTheirOwnRecord(
  request: APIRequestContext,
  url: string,
): Promise<string> {
  const gold = await untilHit(request, url, "gold");
  expect(gold).toMatch(/^gold:/);
  expect(await renderOf(request, url, "silver")).toMatch(/^silver:/);
  expect(await untilHit(request, url, "silver")).toMatch(/^silver:/);
  expect(await renderOf(request, url, "gold")).toBe(gold);
  return gold;
}

async function expectInheritedPartition(
  request: APIRequestContext,
  url: (path: string) => string,
): Promise<void> {
  const probe = crypto.randomUUID().slice(0, 8);
  const gold = await expectTiersKeepTheirOwnRecord(
    request,
    url(`/cache-test/nested-key?probe=${probe}`),
  );
  // The outer key() names no route; the sibling under the same inner
  // cache() keeps its own record.
  const sibling = await renderOf(
    request,
    url(`/cache-test/nested-key-sibling?probe=${probe}`),
    "gold",
  );
  expect(sibling).toMatch(/^sibling-gold:/);
  expect(sibling).not.toBe(gold);
}

async function expectComposedPartition(
  request: APIRequestContext,
  url: (path: string) => string,
): Promise<void> {
  const probe = crypto.randomUUID().slice(0, 8);
  const path = `/cache-test/nested-key-composed?probe=${probe}`;
  const goldA = await expectTiersKeepTheirOwnRecord(
    request,
    url(`${path}&variant=a`),
  );
  // The inner key() still splits within the tier.
  const goldB = await renderOf(request, url(`${path}&variant=b`), "gold");
  expect(goldB).toMatch(/^gold:/);
  expect(goldB).not.toBe(goldA);
}

test.describe("nested cache() under a keyed cache()", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });

  test("an inner cache() without key(): each tier replays only its own record", async ({
    request,
  }) => {
    await expectInheritedPartition(request, f.url);
  });

  test("an inner key() composes with the tier: no shared record, the variant still splits", async ({
    request,
  }) => {
    await expectComposedPartition(request, f.url);
  });
});

test.describe("nested cache() under a keyed cache() (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });

  test("an inner cache() without key(): each tier replays only its own record", async ({
    request,
  }) => {
    await expectInheritedPartition(request, f.url);
  });

  test("an inner key() composes with the tier: no shared record, the variant still splits", async ({
    request,
  }) => {
    await expectComposedPartition(request, f.url);
  });
});
