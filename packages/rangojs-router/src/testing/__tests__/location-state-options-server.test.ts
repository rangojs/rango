import { expect, it } from "vitest";
import {
  runInRequestContext,
  runLoaderResult,
  runMiddleware,
  withLocationStateKey,
} from "../index.js";
import { createLocationState } from "../../browser/react/location-state-shared.js";
import { redirect } from "../../route-definition/redirect.js";

// Userland contract for the server primitives' `locationState` (#994):
// `{ [Def.__rsc_ls_key]: value }` for every definition, and nothing else.
// `clearOnReload` is in the key, the value is what the code under test passed,
// which is also what a renderRoute seed takes. No app version appears: the
// client records its own when it stores the state in a history entry.

const Flash = withLocationStateKey(
  createLocationState<{ text: string }>({ flash: true }),
  "Flash",
);
const Carried = withLocationStateKey(
  createLocationState<string[]>({ clearOnReload: true }),
  "Carried",
);

const entries = () => [Flash({ text: "Saved" }), Carried(["p1", "p2"])];

it.each([
  [
    "runMiddleware: ctx.setLocationState()",
    () =>
      runMiddleware(
        async (ctx, next) => {
          ctx.setLocationState(entries());
          return next();
        },
        { request: "/" },
      ),
  ],
  [
    "runMiddleware: redirect({ state })",
    () =>
      runMiddleware(async () => redirect("/app", { state: entries() }), {
        request: "/login",
      }),
  ],
  [
    "runLoaderResult: throw redirect({ state })",
    () =>
      runLoaderResult(async () => {
        throw redirect("/app", { state: entries() });
      }),
  ],
  [
    "runInRequestContext: an action's ctx.setLocationState()",
    () => runInRequestContext((ctx) => ctx.setLocationState(entries())),
  ],
])("%s returns the raw values under each definition's key", async (_, run) => {
  const { locationState } = await run();

  expect(locationState).toStrictEqual({
    __rsc_ls_Flash: { text: "Saved" },
    "__rsc_ls_Carried~r": ["p1", "p2"],
  });
  expect(locationState).toStrictEqual({
    [Flash.__rsc_ls_key]: { text: "Saved" },
    [Carried.__rsc_ls_key]: ["p1", "p2"],
  });
});
