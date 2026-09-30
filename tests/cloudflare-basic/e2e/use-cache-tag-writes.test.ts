import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

// "use cache" tag ownership and write gating on the real CFCacheStore.
// Fixtures: src/use-cache-tags-data.ts, pages/nested-use-cache.tsx.
//
// - #980: a "use cache" function whose only tag comes from the "use cache"
//   function it calls. The server action's updateTag() of that inner tag
//   must evict the outer entry, so the action's own re-render is fresh, and
//   the next render fills it again.
// - #977: a "use cache" body held (a KV flag) after it read its data (KV).
//   Another request changes the data and runs updateTag() on the entry's tag
//   while it is held; the held execution still answers with what it read,
//   and must not write it. The next read runs the body again and fills the
//   store, so the read after it is a HIT.
//
// Local workerd serves every request from one isolate, so the #977 case
// proves the gate against this isolate's own invalidation history
// (invalidation-order.ts). The KV marker path, for another isolate's
// invalidation, is pinned by the unit suites with a second store over the
// same KV (packages/rangojs-router/src/testing/__tests__/
// tag-write-after-invalidation.rsc-test.ts).

// Serial: the marker writes share the KV namespace.
test.describe.configure({ mode: "serial" });

function uniqueProbe(name: string): string {
  return `${name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The card's stock once two reloads in a row agree: a HIT of the stored
 * outer entry. The write is a background task, so a render before it lands
 * renders again.
 */
async function cachedStock(page: Page): Promise<string> {
  let stock = "";
  await expect
    .poll(
      async () => {
        await page.reload();
        await waitForHydration(page);
        stock = (await testId(page, "nested-card-stock").textContent()) ?? "";
        await page.reload();
        await waitForHydration(page);
        return (
          (await testId(page, "nested-card-stock").textContent()) === stock
        );
      },
      { timeout: 15000, message: "expected a HIT of the card entry" },
    )
    .toBe(true);
  return stock;
}

function describeUseCacheTagWrites(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";

  test.describe(`use cache tag writes (${label})`, () => {
    const f = useFixture({ root: ".", mode });

    test("a server action's updateTag() of a nested use cache tag evicts the enclosing entry", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url(`/nested-use-cache/${uniqueProbe("card")}`));
      await waitForHydration(page);
      const first = await cachedStock(page);
      expect(first).toBeTruthy();

      await testId(page, "nested-invalidate").click();
      await expect(testId(page, "nested-card-stock")).not.toHaveText(first);

      // Filled again: a later render is a HIT of a new entry.
      expect(await cachedStock(page)).not.toBe(first);
    });

    test("a use cache execution held across another request's updateTag() does not write its value", async ({
      request,
    }) => {
      const probe = uniqueProbe("held");
      const json = { headers: { Accept: "application/json" } };
      const control = async (op: string) => {
        const res = await request.get(
          f.url(`/held-use-cache/${probe}/${op}`),
          json,
        );
        expect(res.status()).toBe(200);
        return res.json();
      };
      const read = async (): Promise<{ value: string; run: string }> =>
        (await request.get(f.url(`/held-use-cache/${probe}`), json)).json();

      await control("hold");
      const first = read();
      await expect
        .poll(async () => (await control("started")).started, {
          timeout: 15000,
        })
        .toBe(true);
      // Another request: new data, and updateTag() of the entry's tag.
      await control("mutate");
      await control("release");
      expect((await first).value).toBe("old");

      // The held execution's write would land in the background: give it
      // time, then the next read must run the body on the new data.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect((await read()).value).toBe("new");
      // And a run after the invalidation fills the store again: two reads in
      // a row agree on the run, a HIT (a gate that skipped every write never
      // gets there).
      let hit = { value: "", run: "" };
      await expect
        .poll(
          async () => {
            hit = await read();
            return (await read()).run === hit.run;
          },
          { timeout: 15000, message: "expected a HIT after the refill" },
        )
        .toBe(true);
      expect(hit.value).toBe("new");
    });
  });
}

describeUseCacheTagWrites("dev");
describeUseCacheTagWrites("build");
