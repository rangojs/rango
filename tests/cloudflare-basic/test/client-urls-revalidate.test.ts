import { describe, expect, it } from "vitest";
import { runRevalidate } from "@rangojs/router/testing";
import { clientUrlsResultAction } from "../src/client-urls/actions.js";
import { onResultOk } from "../src/client-urls/predicates.js";

// The build stamps a "use server" export with its id ($id), which isAction()
// matches; this Vitest project does not run that plugin, so stamp it here.
const RESULT_ACTION = "src/client-urls/actions.ts#clientUrlsResultAction";
Object.assign(clientUrlsResultAction, { $id: RESULT_ACTION });

/**
 * Dogfood of runRevalidate against cloudflare-basic's clientUrls() predicate
 * (src/client-urls/predicates.ts): it runs through the router's own
 * evaluateRevalidation with the arguments the server passes on an action.
 */
describe("clientUrls() revalidate() predicates (cloudflare-basic)", () => {
  it("onResultOk re-runs after the result action succeeds and holds after it fails", async () => {
    expect(
      await runRevalidate(onResultOk, {
        action: { ref: RESULT_ACTION, result: { ok: true } },
      }),
    ).toBe(true);
    expect(
      await runRevalidate(onResultOk, {
        action: { ref: RESULT_ACTION, result: { ok: false } },
      }),
    ).toBe(false);
  });

  it("onResultOk defers to the default on other actions and navigations", async () => {
    // An action re-runs a route's loader by default.
    expect(
      await runRevalidate(onResultOk, {
        action: { ref: "src/client-urls/actions.ts#clientUrlsTargetAction" },
      }),
    ).toBe(true);
    // A navigation that changes no params keeps it.
    expect(
      await runRevalidate(onResultOk, { currentUrl: "/__client-urls" }),
    ).toBe(false);
  });
});
