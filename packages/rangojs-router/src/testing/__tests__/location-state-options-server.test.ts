import { describe, expect, it } from "vitest";
import {
  runInRequestContext,
  runLoaderResult,
  runMiddleware,
  withLocationStateKey,
} from "../index.js";
import { createLocationState } from "../../browser/react/location-state-shared.js";
import { redirect } from "../../route-definition/redirect.js";
import type { MiddlewareFn } from "../../router/middleware.js";

// Userland contract for the server primitives' `locationState` with the
// createLocationState options of #994. The record is what the response carries
// and `history.state` receives: a raw value for a definition without `version`
// or `clearOnReload`, the definition's envelope with one. `Def.read({ state })`
// decodes either, so it is the assertion that survives adopting an option
// (renderRoute's `locationState` seeds are the mirror: they take the value and
// the definition encodes it).

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
// The next deploy's definition of the same slot.
const VersionedFlashV3 = withLocationStateKey(
  createLocationState<{ message: string }>({ flash: true, version: 3 }),
  "VersionedFlash",
);

const entries = () => [
  Flash({ text: "Saved" }),
  VersionedFlash({ text: "Welcome back" }),
  Carried(["p1", "p2"]),
];

function expectLocationState(locationState: Record<string, unknown>): void {
  expect(locationState).toEqual({
    __rsc_ls_Flash: { text: "Saved" },
    __rsc_ls_VersionedFlash: {
      __rsc_ls_env: 1,
      v: 2,
      value: { text: "Welcome back" },
    },
    __rsc_ls_Carried: {
      __rsc_ls_env: 1,
      clearOnReload: true,
      value: ["p1", "p2"],
    },
  });

  const state = locationState;
  expect(Flash.read({ state })).toEqual({ text: "Saved" });
  expect(VersionedFlash.read({ state })).toEqual({ text: "Welcome back" });
  expect(Carried.read({ state })).toEqual(["p1", "p2"]);
  expect(VersionedFlashV3.read({ state })).toBeUndefined();
}

describe("server primitives: locationState with version / clearOnReload", () => {
  it("runMiddleware: ctx.setLocationState()", async () => {
    const mw: MiddlewareFn = async (ctx, next) => {
      ctx.setLocationState(entries());
      return next();
    };
    const { locationState } = await runMiddleware(mw, { request: "/" });
    expectLocationState(locationState);
  });

  it("runMiddleware: redirect({ state })", async () => {
    const mw: MiddlewareFn = async () =>
      redirect("/dashboard", { state: entries() });
    const { locationState, response } = await runMiddleware(mw, {
      request: "/login",
    });
    expect(response.headers.get("Location")).toBe("/dashboard");
    expectLocationState(locationState);
  });

  it("runLoaderResult: throw redirect({ state })", async () => {
    const { locationState, thrown } = await runLoaderResult(async () => {
      throw redirect("/dashboard", { state: entries() });
    });
    expect(thrown).toBeInstanceOf(Response);
    expectLocationState(locationState);
  });

  it("runInRequestContext: an action's ctx.setLocationState()", async () => {
    const { locationState } = await runInRequestContext((ctx) => {
      ctx.setLocationState(entries());
    });
    expectLocationState(locationState);
  });
});
