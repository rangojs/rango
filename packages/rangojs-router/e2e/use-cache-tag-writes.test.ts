import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * "use cache" tag ownership and write gating on Node with the memory store.
 * Fixtures: e2e/test-app/src/urls/cache-tag.tsx and cache-tag-data.ts.
 *
 * - #980: /cache-tag-test/card/:id reads a "use cache" function whose only
 *   tag comes from the "use cache" function it calls. Its action runs
 *   updateTag() on that inner tag; the outer entry must go with it, and the
 *   next render fills it again.
 * - #977: /cache-tag-test/held/:id holds its "use cache" body after it read
 *   its data. Another request changes the data and runs updateTag() on the
 *   entry's tag while it is held: the held execution still answers with
 *   what it read, and must not write it. The next read runs the body again
 *   and fills the store, so the read after it is a HIT.
 */
function defineUseCacheTagWriteTests(f: Fixture, label: string): void {
  const json = { headers: { Accept: "application/json" } };
  const unique = (name: string) =>
    `${name}-${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  test('a server action\'s updateTag() of a nested "use cache" tag evicts the enclosing entry (#980)', async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    const url = f.url(`/cache-tag-test/card/${unique("card")}`);
    const cardTs = async () => {
      await page.goto(url);
      await waitForHydration(page);
      return page.getByTestId("nested-card-ts").textContent();
    };
    // The outer write is a background task: a render before it lands renders
    // again. Two reloads in a row that agree are a HIT of the stored entry.
    const cachedTs = async (): Promise<string> => {
      let ts = "";
      await expect
        .poll(
          async () => {
            ts = (await cardTs()) ?? "";
            return (await cardTs()) === ts;
          },
          { timeout: 15000, message: "expected a HIT of the card entry" },
        )
        .toBe(true);
      return ts;
    };

    const first = await cachedTs();
    expect(first).toMatch(/^\d+$/);

    await page.getByTestId("invalidate-tag-btn").click();
    await expect(page.getByTestId("invalidate-tag-result")).toBeVisible();

    // Evicted, then filled again: a later render is a HIT of a new entry.
    const refilled = await cachedTs();
    expect(refilled).not.toBe(first);
  });

  test('a "use cache" execution held across another request\'s updateTag() does not write its value (#977)', async ({
    request,
  }) => {
    const id = unique("held");
    const control = async (op: string) => {
      const res = await request.get(
        f.url(`/cache-tag-test/held/${id}/${op}`),
        json,
      );
      expect(res.status()).toBe(200);
      return res.json();
    };
    const read = async (): Promise<{ value: string; run: number }> =>
      (await request.get(f.url(`/cache-tag-test/held/${id}`), json)).json();

    await control("hold");
    const first = read();
    await expect
      .poll(async () => (await control("started")).started, { timeout: 10000 })
      .toBe(true);
    // Another request: new data, and updateTag() of the entry's tag.
    await control("mutate");
    await control("release");
    expect(await first).toEqual({ value: "old", run: 1 });

    // The held execution's write would land in the background: give it time,
    // then the next read must run the body on the new data.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await read()).toEqual({ value: "new", run: 2 });
    // And a run after the invalidation fills the store again: two reads in a
    // row agree on the run, a HIT (a gate that skipped every write never
    // gets there).
    let hit = { value: "", run: 0 };
    await expect
      .poll(
        async () => {
          hit = await read();
          return (await read()).run === hit.run;
        },
        { timeout: 10000, message: "expected a HIT after the refill" },
      )
      .toBe(true);
    expect(hit.value).toBe("new");
  });
}

test.describe("use cache tag writes", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  defineUseCacheTagWriteTests(f, "dev");
});

test.describe("use cache tag writes (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  defineUseCacheTagWriteTests(f, "prod");
});
