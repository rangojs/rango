import { createElement, type ReactNode } from "react";
import type { ErrorInfo, LoaderDataResult } from "../types.js";
import {
  getRedirectState,
  isExternalRedirect,
  resolveSoftRedirectUrl,
} from "../redirect-origin.js";
import { DataNotFoundError, isDataNotFoundError } from "../errors.js";
import { isRedirectResponse } from "../response-utils.js";
import type { LocationStateDefinition } from "../browser/react/location-state-shared.js";
import { locationStateSlots } from "./location-state-key.js";

/**
 * What a loader threw, for `loaderFailure()`: one of
 * - `{ notFound: true }`: the loader called `notFound()`;
 * - `{ redirect }`: the loader threw `redirect(url)`;
 * - `{ error }`: the loader threw anything else.
 */
export type LoaderFailureInit =
  | {
      notFound: true;
      /** `notFound(message)`'s message. Defaults to `notFound()`'s. */
      message?: string;
      /**
       * The not-found UI the server rendered for the loader: the nearest
       * `notFoundBoundary()`'s, else `createRouter({ notFound })`'s. Defaults
       * to the router's own default, as when neither is set.
       */
      fallback?: ReactNode;
    }
  | {
      /**
       * The redirect's target, as its `Location` header holds it. A
       * cross-origin target lands on "/", as the server's same-origin guard
       * sends a redirect without `{ external: true }`.
       */
      redirect: string;
      /** `redirect(url, { state })`'s location state, as `[def, value]` pairs. */
      state?: ReadonlyArray<
        readonly [LocationStateDefinition<any, any>, unknown]
      >;
    }
  | {
      /**
       * What the loader threw. A `DataNotFoundError` is a `notFound()` and a
       * 3xx `Response` a redirect, as on the server.
       */
      error: unknown;
      /**
       * The nearest `errorBoundary()`'s UI, as the server rendered it (for a
       * `DataNotFoundError`, the not-found UI, as `notFound`'s `fallback`).
       * Without it the loader has no error boundary: its read throws the
       * error to the nearest error boundary of the app.
       */
      fallback?: ReactNode;
    };

declare const LOADER_FAILURE: unique symbol;

/**
 * A loader's failed result, from `loaderFailure()`. Seed it where loader data
 * goes in `renderRoute`.
 */
export interface LoaderFailure {
  readonly [LOADER_FAILURE]: true;
}

/**
 * The ErrorInfo createErrorInfo (router/error-handling.ts) gives in dev. The
 * segment id is left empty: the browser reads only the error's identity
 * (decode-loader-results.ts loaderResultError).
 */
function errorInfoOf(thrown: unknown): ErrorInfo {
  if (thrown instanceof Error) {
    return {
      message: thrown.message,
      name: thrown.name,
      code: (thrown as { code?: string }).code,
      stack: thrown.stack,
      cause: thrown.cause,
      segmentId: "",
      segmentType: "loader",
    };
  }
  return {
    message: String(thrown),
    name: "Error",
    segmentId: "",
    segmentType: "loader",
  };
}

/**
 * The result a loader that threw sends to the browser, for `renderRoute`'s
 * loader seeds: its `loaders` option and the `loaders` of `navigate()`,
 * `refresh()`, `prefetch()`, `action()` and `respondToLoads()`, or the value a
 * pending seed Promise resolves to (a loader that fails while it streams).
 *
 * The router places it as it places a real one
 * (loader-resolution.ts wrapLoaderWithErrorHandling builds the same result):
 * a `notFound()` renders its not-found UI and a `redirect()` replace-navigates
 * to its target, both in place of the segment's content, inside the route's
 * loader error boundary; an error with an `errorBoundary()` fallback renders
 * that fallback there, and one without throws at its `useLoader()` read. A
 * `useLoader().load()` the endpoint answers with a failure rejects (an error
 * with its message, as the real endpoint's loaderError does).
 *
 * @example
 * await router.navigate("/items/7", {
 *   loaders: [[ItemLoader, loaderFailure({ notFound: true, fallback: <ItemGone /> })]],
 * });
 */
export function loaderFailure(init: LoaderFailureInit): LoaderFailure {
  let result: LoaderDataResult<never>;
  if ("notFound" in init) {
    result = notFoundResult(init.message, init.fallback);
  } else if ("redirect" in init) {
    const state = locationStateSlots(init.state);
    result = redirectResult(init.redirect, {
      status: 302,
      state: Object.keys(state).length > 0 ? state : undefined,
      external: false,
    });
  } else if (isDataNotFoundError(init.error)) {
    // The loader-resolution.ts rule: a thrown notFound() is the signal, not an
    // error, and `fallback` is the not-found UI the server rendered for it.
    result = notFoundResult(init.error.message, init.fallback);
  } else if (init.error instanceof Response && isRedirectResponse(init.error)) {
    // So is a thrown 3xx Response, with what redirect() put on it.
    result = redirectResult(init.error.headers.get("Location")!, {
      status: init.error.status,
      state: getRedirectState(init.error),
      external: isExternalRedirect(init.error),
    });
  } else {
    result = {
      __loaderResult: true,
      ok: false,
      error: errorInfoOf(init.error),
      fallback: init.fallback ?? null,
    };
  }
  return result as unknown as LoaderFailure;
}

function notFoundResult(
  message: string | undefined,
  fallback: ReactNode | undefined,
): LoaderDataResult<never> {
  const error = new DataNotFoundError(message);
  return {
    __loaderResult: true,
    ok: false,
    notFound: true,
    error: errorInfoOf(error),
    // A boundary that rendered null is a null fallback; no boundary is the
    // router's default (router/error-handling.ts resolveDefaultNotFound).
    fallback:
      fallback !== undefined
        ? fallback
        : createElement("h1", null, "Not Found"),
  };
}

/**
 * The redirect marker loader-resolution.ts builds: the target resolved by the
 * soft-redirect rules against the page's origin, the one LoaderRedirect
 * resolves it against again.
 */
function redirectResult(
  location: string,
  {
    status,
    state,
    external,
  }: {
    status: number;
    state: Record<string, unknown> | undefined;
    external: boolean;
  },
): LoaderDataResult<never> {
  const origin =
    typeof window === "undefined" ? "http://localhost" : window.location.origin;
  const to = resolveSoftRedirectUrl(location, origin, undefined, external);
  return {
    __loaderResult: true,
    ok: false,
    redirect: { to, status, ...(state && { state }) },
    error: errorInfoOf(new Error(`Loader redirected to ${to}`)),
    fallback: null,
  };
}
