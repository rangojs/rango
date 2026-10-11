import { expect, test, type APIRequestContext } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

// Serial and one run id per test: the locations share one KV and one worker.
test.describe.configure({ mode: "serial" });

/**
 * CFCacheStore `kvFallThrough` across two edge locations. With the option on
 * (the fixture's location store enables it; `x-test-kv-fall-through: off`
 * builds the store with the default), a location whose own
 * Cache API copy a tag marker rejects reads the entry's KV key and serves what
 * another location rebuilt after the invalidation, instead of rendering it
 * again (docs/design/caching.md, "Implementations").
 *
 * One workerd instance is one real location, but the store's `namespace` scopes
 * only the Cache API and the isolate memos; KV entry and marker keys carry no
 * namespace. src/location-store.ts builds a store per request whose namespace
 * comes from the `x-test-location` header, so two header values are two
 * locations (two Cache APIs) over the one KV binding.
 *
 * The fixture route counts its renders per run id. "Served without rendering"
 * is the counter not moving for the location that reads.
 */

const TAG = "cf-location-items";

function defineLocationTests(f: Fixture) {
  let run = 0;
  const newRun = (): string => `${Date.now()}-${run++}`;

  const get = (
    request: APIRequestContext,
    location: string,
    id: string,
    fallThrough: "on" | "off" = "on",
  ): Promise<{ run: string; renders: number }> =>
    request
      .get(f.url(`/test/location-tagged?run=${id}`), {
        headers: {
          "x-test-location": location,
          "x-test-kv-fall-through": fallThrough,
        },
      })
      .then(async (res) => {
        expect(res.status()).toBe(200);
        return res.json();
      });

  const renders = async (
    request: APIRequestContext,
    id: string,
  ): Promise<number> =>
    (
      await (
        await request.get(f.url(`/__test/location-renders?run=${id}`))
      ).json()
    ).renders;

  /** The renders count the entries in KV hold, once a write has landed. */
  const kvHolds = async (
    request: APIRequestContext,
    id: string,
    count: number,
  ): Promise<boolean> => {
    const { values } = await (
      await request.get(f.url(`/__test/location-kv?run=${id}`))
    ).json();
    return values.some((value: string) => value.includes(`"renders":${count}`));
  };

  test("after updateTag, a location holding the old copy serves the entry another location rebuilt, without rendering", async ({
    request,
  }) => {
    const id = newRun();

    // Location B renders v1 and holds its own copy; the write reaches KV.
    expect(await get(request, "b", id)).toMatchObject({ renders: 1 });
    await expect
      .poll(() => kvHolds(request, id, 1), { timeout: 8000 })
      .toBe(true);
    // B's own copy serves (same value, no render).
    await expect
      .poll(async () => (await get(request, "b", id)).renders, {
        timeout: 8000,
      })
      .toBe(1);
    expect(await renders(request, id)).toBe(1);

    // updateTag in location A: every location's copy is now unservable.
    const inv = await request.get(f.url(`/test/invalidate-tag/${TAG}`), {
      headers: { "x-test-location": "a" },
    });
    expect(inv.status()).toBe(200);

    // A has no copy, KV holds the entry from before the marker (refused), so A
    // renders v2 and writes it to its own L1 and to KV.
    expect(await get(request, "a", id)).toMatchObject({ renders: 2 });
    await expect
      .poll(() => kvHolds(request, id, 2), { timeout: 8000 })
      .toBe(true);
    expect(await renders(request, id)).toBe(2);

    // B's copy is rejected by the marker; its KV read finds A's v2, written
    // after the marker: served, and the render counter does not move.
    expect(await get(request, "b", id)).toMatchObject({ renders: 2 });
    expect(await renders(request, id)).toBe(2);

    // Promoted into B's own L1: still no render.
    expect(await get(request, "b", id)).toMatchObject({ renders: 2 });
    expect(await renders(request, id)).toBe(2);
  });

  test("after updateTag with no rebuild, KV holds only the entry from before the marker: refused, and the location renders", async ({
    request,
  }) => {
    const id = newRun();
    expect(await get(request, "b", id)).toMatchObject({ renders: 1 });
    await expect
      .poll(() => kvHolds(request, id, 1), { timeout: 8000 })
      .toBe(true);
    await expect
      .poll(async () => (await get(request, "b", id)).renders, {
        timeout: 8000,
      })
      .toBe(1);

    const inv = await request.get(f.url(`/test/invalidate-tag/${TAG}`), {
      headers: { "x-test-location": "a" },
    });
    expect(inv.status()).toBe(200);

    // The pre-marker copy is never served: B renders.
    expect(await get(request, "b", id)).toMatchObject({ renders: 2 });
    expect(await renders(request, id)).toBe(2);
  });

  test("kvFallThrough off (the default): the location holding the old copy renders although KV holds the rebuilt entry", async ({
    request,
  }) => {
    const id = newRun();
    expect(await get(request, "b", id)).toMatchObject({ renders: 1 });
    await expect
      .poll(() => kvHolds(request, id, 1), { timeout: 8000 })
      .toBe(true);
    await expect
      .poll(async () => (await get(request, "b", id)).renders, {
        timeout: 8000,
      })
      .toBe(1);

    const inv = await request.get(f.url(`/test/invalidate-tag/${TAG}`), {
      headers: { "x-test-location": "a" },
    });
    expect(inv.status()).toBe(200);

    expect(await get(request, "a", id)).toMatchObject({ renders: 2 });
    await expect
      .poll(() => kvHolds(request, id, 2), { timeout: 8000 })
      .toBe(true);

    // B's copy is rejected and, with the option off, KV is not read: B renders.
    expect(await get(request, "b", id, "off")).toMatchObject({ renders: 3 });
    expect(await renders(request, id)).toBe(3);
  });
}

test.describe("CF KV fall-through across locations (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  defineLocationTests(f);
});

test.describe("CF KV fall-through across locations (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  defineLocationTests(f);
});
