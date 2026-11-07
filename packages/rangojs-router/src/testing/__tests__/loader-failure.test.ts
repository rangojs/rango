// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import {
  decodeLoaderEntry,
  LOADER_ERROR_FALLBACK,
  LOADER_NOT_FOUND_FALLBACK,
  loaderRedirectOf,
} from "../../decode-loader-results.js";
import { createLocationState } from "../../client.js";
import { DataNotFoundError } from "../../errors.js";
import { attachRedirectState } from "../../redirect-origin.js";
import { loaderFailure } from "../loader-failure.js";
import { withLocationStateKey } from "../location-state-key.js";

// loaderFailure() builds the result the browser decodes for a loader that
// threw (loader-resolution.ts wrapLoaderWithErrorHandling): these read it
// back through the router's own read-site decode.

function thrownBy(seed: unknown): Error & Record<PropertyKey, unknown> {
  try {
    decodeLoaderEntry(seed);
  } catch (error) {
    return error as Error & Record<PropertyKey, unknown>;
  }
  throw new Error("decodeLoaderEntry did not throw");
}

describe("loaderFailure", () => {
  it("notFound: a DataNotFoundError carrying the fallback", () => {
    const fallback = createElement("p", null, "gone");
    const error = thrownBy(loaderFailure({ notFound: true, fallback }));
    expect(error.name).toBe("DataNotFoundError");
    expect(error.message).toBe("Not found");
    expect(error[LOADER_NOT_FOUND_FALLBACK]).toBe(fallback);
  });

  it("notFound: the message, and a null fallback kept null", () => {
    const error = thrownBy(
      loaderFailure({ notFound: true, message: "No item 7", fallback: null }),
    );
    expect(error.message).toBe("No item 7");
    expect(error[LOADER_NOT_FOUND_FALLBACK]).toBeNull();
  });

  it("notFound: the router's default not-found UI without a fallback", () => {
    const error = thrownBy(loaderFailure({ notFound: true }));
    expect(error[LOADER_NOT_FOUND_FALLBACK]).toMatchObject({
      type: "h1",
      props: { children: "Not Found" },
    });
  });

  it("redirect: the same-origin target with its location state", () => {
    const Flash = withLocationStateKey(
      createLocationState<string>(),
      "LoaderFailureUnitFlash",
    );
    const error = thrownBy(
      loaderFailure({ redirect: "/login?next=/a", state: [[Flash, "hi"]] }),
    );
    expect(loaderRedirectOf(error)).toEqual({
      to: new URL("/login?next=/a", window.location.origin).href,
      status: 302,
      state: { __rsc_ls_LoaderFailureUnitFlash: "hi" },
    });
  });

  it("redirect: a cross-origin target lands on the root", () => {
    const error = thrownBy(
      loaderFailure({ redirect: "https://elsewhere.test" }),
    );
    expect(loaderRedirectOf(error)).toEqual({ to: "/", status: 302 });
  });

  it("error: the thrown error's identity, its fallback riding the throw", () => {
    const fallback = createElement("p", null, "oops");
    const thrown = Object.assign(new RangeError("too far"), { code: "E_FAR" });
    const error = thrownBy(loaderFailure({ error: thrown, fallback }));
    expect(error).toMatchObject({
      name: "RangeError",
      message: "too far",
      code: "E_FAR",
    });
    expect(error[LOADER_ERROR_FALLBACK]).toBe(fallback);
  });

  it("error: a DataNotFoundError is a notFound(), with the fallback given", () => {
    const fallback = createElement("p", null, "gone");
    const error = thrownBy(
      loaderFailure({ error: new DataNotFoundError("No item 7"), fallback }),
    );
    expect(error.name).toBe("DataNotFoundError");
    expect(error.message).toBe("No item 7");
    expect(error[LOADER_NOT_FOUND_FALLBACK]).toBe(fallback);
  });

  it("error: a 3xx Response is a redirect to its Location, with its status and redirect() state", () => {
    const response = new Response(null, {
      status: 303,
      headers: { Location: "/login" },
    });
    attachRedirectState(response, { __rsc_ls_Flash: "hi" });
    const error = thrownBy(loaderFailure({ error: response }));
    expect(loaderRedirectOf(error)).toEqual({
      to: new URL("/login", window.location.origin).href,
      status: 303,
      state: { __rsc_ls_Flash: "hi" },
    });
  });

  it("error: a thrown non-Error without a fallback", () => {
    const error = thrownBy(loaderFailure({ error: "boom" }));
    expect(error).toMatchObject({ name: "Error", message: "boom" });
    expect(LOADER_ERROR_FALLBACK in error).toBe(false);
  });
});
