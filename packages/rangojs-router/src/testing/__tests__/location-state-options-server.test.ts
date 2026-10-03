import { expect, it } from "vitest";
import {
  runInRequestContext,
  runLoaderResult,
  runMiddleware,
  withLocationStateKey,
} from "../index.js";
import { createLocationState } from "../../browser/react/location-state-shared.js";
import { redirect } from "../../route-definition/redirect.js";

// Userland contract for the server primitives' `locationState` with the
// createLocationState options of #994: `{ [Def.__rsc_ls_key]: value }` for
// every definition. The options are in the key, the value is what the code
// under test passed, which is also what a renderRoute seed takes.

const Flash = withLocationStateKey(
  createLocationState<{ text: string }>({ flash: true }),
  "Flash",
);
const VersionedFlash = withLocationStateKey(
  createLocationState<{ text: string }>({ flash: true, version: 2 }),
  "VersionedFlash",
);
const Carried = withLocationStateKey(
  createLocationState<string[]>({ clearOnReload: true }),
  "Carried",
);

const entries = () => [
  Flash({ text: "Saved" }),
  VersionedFlash({ text: "Welcome back" }),
  Carried(["p1", "p2"]),
];

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

  expect(locationState).toEqual({
    __rsc_ls_Flash: { text: "Saved" },
    "__rsc_ls_VersionedFlash~v2": { text: "Welcome back" },
    "__rsc_ls_Carried~r": ["p1", "p2"],
  });
  expect(locationState).toEqual({
    [Flash.__rsc_ls_key]: { text: "Saved" },
    [VersionedFlash.__rsc_ls_key]: { text: "Welcome back" },
    [Carried.__rsc_ls_key]: ["p1", "p2"],
  });
});
