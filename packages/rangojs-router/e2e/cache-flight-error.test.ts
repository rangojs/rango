import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

/**
 * A cache() route whose async child component throws during the cache write
 * is not stored (issue #909). Fixture: e2e/test-app/src/urls/cache.tsx
 * (/cache-test/flight-error): the first handler run per ?k= throws in the live
 * render and in the write's re-render, later runs render. The status route
 * reports whether the write stored and whether onError got its cache-write.
 */

const RUN = /data-testid="flight-error-run">(\d+)</;
const REVIEWS_OK = 'data-testid="flight-error-reviews">reviews ok';

function defineFlightErrorTests(f: Fixture): void {
  test("a write whose async child threw is not stored; the next request renders fresh", async ({
    request,
  }) => {
    const k = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const load = async () => {
      const res = await request.get(f.url(`/cache-test/flight-error?k=${k}`), {
        headers: { Accept: "text/html" },
      });
      expect(res.status()).toBe(200);
      const html = await res.text();
      return { run: html.match(RUN)?.[1], ok: html.includes(REVIEWS_OK) };
    };
    const status = async (): Promise<{ stored: boolean; refused: boolean }> =>
      (
        await request.get(f.url(`/cache-test/flight-error-status?k=${k}`))
      ).json();

    expect(await load()).toEqual({ run: "1", ok: false });
    let settled = { stored: false, refused: false };
    await expect
      .poll(async () => {
        settled = await status();
        return settled.stored || settled.refused;
      })
      .toBe(true);

    // Not a HIT of the errored entry: the handler runs again and the child renders.
    expect(await load()).toEqual({ run: "2", ok: true });
    expect(settled).toEqual({ stored: false, refused: true });

    // The clean render is stored and replayed.
    await expect.poll(async () => (await status()).stored).toBe(true);
    expect(await load()).toEqual({ run: "2", ok: true });
  });
}

test.describe("cache() flight error write", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  defineFlightErrorTests(f);
});

test.describe("cache() flight error write (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  defineFlightErrorTests(f);
});
