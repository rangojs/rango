import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  expectNoReload,
  testId,
} from "./helper";

// Case (b) coverage: an inline `"use server"` action DEFINED INSIDE a server
// component that CLOSES OVER a render-scope value and is passed as a prop to a
// client component. Closing over the value makes plugin-rsc treat it as a bound
// argument: the server emits
//   registerServerReference(fn, id, name).bind(null, encryptActionBoundArgs([captured]))
// and the hoisted fn takes the encrypted blob as its first param (decrypted via
// decryptActionBoundArgs at invoke time). The client never sees the captured
// value, so a correct round-trip proves bound-arg serialization end to end.
// This is the path most exposed to a transformHoistInlineDirective refactor in a
// future @vitejs/plugin-rsc bump. Dev + production.

function defineSpec(label: string, mode: "dev" | "build") {
  test.describe(`inline bound action (${label})`, () => {
    const f = useFixture({
      root: "./e2e/test-app",
      mode,
    });

    test("closure-captured render-scope value round-trips through the action", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/inline-bound-action"));
      await waitForHydration(page);
      await using __ = await expectNoReload(page);

      await expect(testId(page, "inline-bound-action-page")).toBeVisible();

      // The captured value is generated on the server at render time. Read what
      // was actually rendered so the assertion is independent of the (dynamic)
      // token value.
      const rendered = await testId(
        page,
        "inline-bound-action-rendered-captured",
      ).textContent();
      const capturedValue = rendered!.replace(/^rendered:/, "");
      expect(capturedValue).toMatch(/^server-token-/);

      // Before submit, useActionState has no result yet.
      await expect(testId(page, "inline-bound-action-captured")).toHaveText(
        "captured:none",
      );

      // Invoke the action via the client form. The server must decrypt the
      // bound arg and echo it back.
      await testId(page, "inline-bound-action-submit").click();

      // The action's returned state carries the captured (bound) value and the
      // submitted form field. Both must round-trip.
      await expect(testId(page, "inline-bound-action-captured")).toHaveText(
        `captured:${capturedValue}`,
      );
      await expect(testId(page, "inline-bound-action-submitted")).toHaveText(
        "submitted:from-client",
      );
    });
  });
}

defineSpec("dev", "dev");
defineSpec("production", "build");
