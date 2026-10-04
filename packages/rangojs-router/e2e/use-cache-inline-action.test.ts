import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";
import {
  inlineAction,
  readAsync,
  readRendered,
  setSession,
} from "./inline-action.helpers";

// Pins the behavior of an inline `"use server"` action that is CREATED INSIDE a
// `"use cache"` server component and handed to a client component. Three axes
// are locked here, in dev AND production:
//
// 1. CAPTURED render scope is FROZEN at cache-WRITE time. The action closes over
//    a render-scope `token`; the closure compiles to an encrypted bound arg
//    snapshotted when the cache entry is written. On a later hit there is no
//    re-render, so the action replays the write-time token -- identical to the
//    cached rendered token, and unchanged across reloads. The token mixes
//    Date.now()+Math.random(), so a reload returning the SAME token proves the
//    freeze.
//
// 2. The action BODY runs LIVE per invocation. It calls a plain (non-cached)
//    module-level async function; the returned value differs on every call,
//    proving the body is not frozen with the cache (only the captured scope is).
//
// 3. Request scope is LIVE. The body reads cookies() -- forbidden inside
//    `"use cache"`, so reachable only at invocation -- and sees the CURRENT POST
//    request's cookie. The test changes the cookie between submits and the
//    action tracks it, including after a cache hit.
//
// Net contract: closing over render scope bakes one request's values into the
// shared entry (a hazard -- read request scope inside the body or pass an
// externally-created action instead), but the action body itself stays a live
// server function with live request context. See use-cache-api-design.md.

function defineSpec(label: string, mode: "dev" | "build") {
  test.describe(`use cache embedded inline action (${label})`, () => {
    const f = useFixture({
      root: "./e2e/test-app",
      mode,
    });

    test("frozen capture + live body + live request scope", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      const url = f.url("/use-cache-test/cached-inline-action");

      // First load: populates (miss) or serves (hit) the cache entry.
      await setSession(page, url, "sess-1");
      await page.goto(url);
      await waitForHydration(page);
      await expect(inlineAction.page(page)).toBeVisible();

      const rendered1 = await readRendered(page);
      expect(rendered1).toMatch(/^tok-/);

      // Nothing invoked yet.
      await expect(inlineAction.captured(page)).toHaveText("captured:none");
      await expect(inlineAction.asyncValue(page)).toHaveText("async:none");
      await expect(inlineAction.session(page)).toHaveText("session:none");

      // First invocation. Settle on the deterministic live-cookie value.
      await inlineAction.submit(page).click();
      await expect(inlineAction.session(page)).toHaveText("session:sess-1");

      // Captured render scope is frozen: equals the cached rendered token.
      await expect(inlineAction.captured(page)).toHaveText(
        `captured:${rendered1}`,
      );
      // Body ran live: async value present and shaped.
      const async1 = await readAsync(page);
      expect(async1).toMatch(/^async-/);

      // Second invocation with a DIFFERENT cookie.
      await setSession(page, url, "sess-2");
      await inlineAction.submit(page).click();
      // Live request scope: action reads the NEW cookie, not the render scope.
      await expect(inlineAction.session(page)).toHaveText("session:sess-2");

      // Capture still frozen (identical to write-time).
      await expect(inlineAction.captured(page)).toHaveText(
        `captured:${rendered1}`,
      );
      // Body ran live AGAIN: async value differs from the previous invocation.
      const async2 = await readAsync(page);
      expect(async2).toMatch(/^async-/);
      expect(async2).not.toBe(async1);

      // Reload -> forces a fresh request -> cache HIT. The rendered (cached)
      // token is the SAME despite mixing Date.now()+random: the cached output
      // (and the action's captured scope) is frozen.
      await setSession(page, url, "sess-3");
      await page.goto(url);
      await waitForHydration(page);
      const rendered2 = await readRendered(page);
      expect(rendered2).toBe(rendered1);

      // State resets on reload.
      await expect(inlineAction.session(page)).toHaveText("session:none");

      // Invoke after the cache hit.
      await inlineAction.submit(page).click();
      await expect(inlineAction.session(page)).toHaveText("session:sess-3");
      // Capture is STILL the write-time token across a cache hit.
      await expect(inlineAction.captured(page)).toHaveText(
        `captured:${rendered1}`,
      );
      // Body still live: fresh async value, different again.
      const async3 = await readAsync(page);
      expect(async3).not.toBe(async2);
    });
  });
}

defineSpec("dev", "dev");
defineSpec("production", "build");
