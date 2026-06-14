import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";
import {
  inlineAction,
  readAsync,
  readRendered,
  setSession,
} from "./inline-action.helpers";

// Static() and Prerender() render at BUILD time and store Flight payloads that the
// worker deserializes at runtime -- a build-time cache hit, exactly like a
// "use cache" hit. An inline "use server" action embedded in such a handler must
// therefore resolve from the server-references manifest on that hit: the same
// path that 500'd with "server reference not found" before the expose-action-id
// manifest re-assertion. This is the same bug class as use-cache-inline-action,
// reached through the build-time caching mechanisms instead.
//
// Pinned here, in dev AND production:
//   - the embedded action is INVOCABLE on a (build-time) cache hit (no 500);
//   - the action body runs LIVE (fresh async value + live session cookie);
//   - the captured value is carried correctly into the action -- a build-time
//     token for Static, and the per-param article id for Prerender (the canonical
//     cached-list + like-button case, where each prerendered item's action holds
//     its own frozen id).

function defineSpec(label: string, mode: "dev" | "build") {
  const isBuild = mode === "build";

  test.describe(`static + prerender embedded inline action (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });

    test("Static handler: embedded inline action resolves and runs live", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      const url = f.url("/static-inline-action");

      await setSession(page, url, "sess-1");
      await page.goto(url);
      await waitForHydration(page);
      await expect(inlineAction.page(page)).toBeVisible();

      const token1 = await readRendered(page);
      expect(token1).toMatch(/^stok-/);

      // Invocable on a build-time cache hit (this was a 500 before the fix).
      await inlineAction.submit(page).click();
      await expect(inlineAction.session(page)).toHaveText("session:sess-1");
      await expect(inlineAction.captured(page)).toHaveText(
        `captured:${token1}`,
      );
      const async1 = await readAsync(page);
      expect(async1).toMatch(/^async-/);

      // Body runs live: a second call with a new cookie -> fresh async + live cookie.
      await setSession(page, url, "sess-2");
      await inlineAction.submit(page).click();
      await expect(inlineAction.session(page)).toHaveText("session:sess-2");
      const async2 = await readAsync(page);
      expect(async2).not.toBe(async1);

      if (isBuild) {
        // Prerendered once at build: a reload serves the SAME stored token, and
        // the action replays the build-frozen capture. (In dev the handler
        // re-renders on demand, so the token is not stable across reloads.)
        await page.goto(url);
        await waitForHydration(page);
        expect(await readRendered(page)).toBe(token1);

        await setSession(page, url, "sess-3");
        await inlineAction.submit(page).click();
        await expect(inlineAction.session(page)).toHaveText("session:sess-3");
        await expect(inlineAction.captured(page)).toHaveText(
          `captured:${token1}`,
        );
      }
    });

    test("Prerender handler: per-param inline action carries its own id", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // The article/like-button case: each prerendered param has its own action
      // holding that param's frozen id. Both ids prerendered via getParams.
      for (const id of ["a1", "a2"]) {
        const url = f.url(`/prerender-inline-action/${id}`);
        await setSession(page, url, `sess-${id}`);
        await page.goto(url);
        await waitForHydration(page);
        await expect(inlineAction.page(page)).toBeVisible();

        // Rendered token is the (deterministic) article id.
        await expect(inlineAction.rendered(page)).toHaveText(`rendered:${id}`);

        // The embedded like action resolves on the prerender (build-time cache)
        // hit and carries THIS param's id, with a live body.
        await inlineAction.submit(page).click();
        await expect(inlineAction.session(page)).toHaveText(
          `session:sess-${id}`,
        );
        await expect(inlineAction.captured(page)).toHaveText(`captured:${id}`);
        expect(await readAsync(page)).toMatch(/^async-/);
      }
    });
  });
}

defineSpec("dev", "dev");
defineSpec("production", "build");
