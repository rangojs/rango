/**
 * A server-side failure prints its ORIGINAL error (message and stack) to the
 * server console once, where it originates: the loader lane, the Flight
 * render, a segment handler caught by a boundary. Only what reaches the client
 * is masked (createErrorInfo). Another place that sees the same error object
 * in the same request prints nothing more. Control flow never prints.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { wrapLoaderWithErrorHandling } from "../loader-resolution.js";
import { catchSegmentError } from "../segment-resolution/helpers.js";
import { createErrorInfo } from "../error-handling.js";
import { DataNotFoundError } from "../../errors.js";
import { redirect } from "../../route-definition/redirect.js";
import { rewrite } from "../../route-definition/rewrite.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";
import { renderRscFlightStage } from "../../rsc/render-pipeline.js";
import type { EntryData } from "../../server/context.js";

const PAGE = "https://shop.example/product/1";
const LOADER_SEGMENT = "M0L0R1D0.src/loaders.ts#ProductLoader";

const entry = { shortCode: "M0L0R1", type: "route" } as unknown as EntryData;

function makeCtx(signal?: AbortSignal) {
  return createRequestContext({
    env: {},
    request: new Request(PAGE, signal ? { signal } : undefined),
    url: new URL(PAGE),
    variables: {},
  });
}

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted."), {
    name: "AbortError",
  });
}

function wrapLoader(
  error: unknown,
  options: { declared?: boolean; ssrFalse?: boolean } = {},
) {
  return wrapLoaderWithErrorHandling(
    Promise.reject(error),
    entry,
    LOADER_SEGMENT,
    "/product/1",
    () =>
      options.declared ? createElement("p", null, "route boundary") : null,
    createErrorInfo,
    vi.fn(),
    undefined,
    options.ssrFalse,
  );
}

const segmentDeps = {
  callOnError: vi.fn(),
  findNearestErrorBoundary: () => createElement("p", null, "boundary"),
  findNearestNotFoundBoundary: () => null,
} as never;

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The calls that printed `error` itself, as [label, error]. */
function printsOf(error: unknown): unknown[][] {
  return consoleError.mock.calls.filter((call: unknown[]) =>
    call.includes(error),
  );
}

describe("a loader that throws prints the original error once, whatever handles it", () => {
  it.each([
    ["no boundary", {}],
    ["a declared errorBoundary()", { declared: true }],
    [
      "ssr: false, no boundary (the router's default boundary)",
      { ssrFalse: true },
    ],
    [
      "ssr: false, a declared errorBoundary()",
      { declared: true, ssrFalse: true },
    ],
  ])("%s", async (_label, options) => {
    const error = new Error("product service down");

    const result: any = await runWithRequestContext(makeCtx(), () =>
      wrapLoader(error, options),
    );

    // The client still gets the masked rebuild.
    expect(result.error.message).toBe("An error occurred");
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      "[RSC] Loader error (ProductLoader) /product/1:",
      error,
    );
  });

  it("prints nothing for notFound() or a redirect(): control flow", async () => {
    await runWithRequestContext(makeCtx(), async () => {
      await wrapLoader(new DataNotFoundError("gone"));
      await wrapLoader(redirect("/elsewhere"));
    });

    expect(consoleError).not.toHaveBeenCalled();
  });

  it("a loader's own fetch timeout (an AbortError while the request is live) prints", async () => {
    const error = abortError();

    await runWithRequestContext(makeCtx(), () => wrapLoader(error));

    expect(consoleError.mock.calls).toEqual([
      ["[RSC] Loader error (ProductLoader) /product/1:", error],
    ]);
  });

  it("an AbortError after the request itself was aborted prints nothing", async () => {
    const controller = new AbortController();
    controller.abort();

    await runWithRequestContext(makeCtx(controller.signal), () =>
      wrapLoader(abortError()),
    );

    expect(consoleError).not.toHaveBeenCalled();
  });

  it("the same error seen again in the request prints nothing more (a handler's ctx.use of the loader)", async () => {
    const error = new Error("product service down");

    await runWithRequestContext(makeCtx(), async () => {
      await wrapLoader(error);
      catchSegmentError(error, entry, {}, segmentDeps, undefined, "/product/1");
    });

    expect(printsOf(error)).toEqual([
      ["[RSC] Loader error (ProductLoader) /product/1:", error],
    ]);
  });

  it("each request prints its own failure, even for one shared error object", async () => {
    const shared = new Error("module-level rejection");

    await runWithRequestContext(makeCtx(), () => wrapLoader(shared));
    await runWithRequestContext(makeCtx(), () => wrapLoader(shared));

    expect(printsOf(shared)).toHaveLength(2);
  });
});

describe("a handler that throws, caught by a boundary, prints the original error once", () => {
  it("prints the segment and the pathname with the error", async () => {
    const error = new Error("handler failed");

    runWithRequestContext(makeCtx(), () =>
      catchSegmentError(error, entry, {}, segmentDeps, undefined, "/product/1"),
    );

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      "[RSC] Handler error (M0L0R1) /product/1:",
      error,
    );
  });

  it("prints a rewrite() a handler threw: a misuse that renders a 500", () => {
    const thrown = rewrite("/elsewhere");

    runWithRequestContext(makeCtx(), () =>
      catchSegmentError(
        thrown,
        entry,
        {},
        segmentDeps,
        undefined,
        "/product/1",
      ),
    );

    expect(consoleError.mock.calls).toEqual([
      ["[RSC] Handler error (M0L0R1) /product/1:", thrown],
    ]);
  });

  it("prints nothing for notFound(): control flow", () => {
    runWithRequestContext(makeCtx(), () =>
      catchSegmentError(
        new DataNotFoundError("gone"),
        entry,
        {},
        segmentDeps,
        undefined,
        "/product/1",
      ),
    );

    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("a server component that throws in the Flight render prints the original error once", () => {
  function renderFlight(reported: unknown[], signal?: AbortSignal) {
    const ctx = makeCtx(signal);
    return runWithRequestContext(ctx, () =>
      renderRscFlightStage({
        ctx: {
          renderToReadableStream: (
            _payload: unknown,
            options?: { onError?: (error: unknown) => void },
          ) => {
            // Flight reports each error once, inside a Suspense boundary or
            // not; a report can arrive after the request's ALS frame.
            for (const error of reported) {
              setTimeout(() => options?.onError?.(error), 0);
            }
            return new Response("0:null\n").body as ReadableStream<Uint8Array>;
          },
          callOnError: vi.fn(),
        } as never,
        request: ctx.request,
        url: ctx.url,
        env: {},
        payload: {} as never,
      }),
    );
  }

  it("prints the pathname with the error, reported outside the ALS frame", async () => {
    const error = new Error("reviews widget failed");

    renderFlight([error]);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      "[RSC] Rendering error /product/1:",
      error,
    );
  });

  it("prints nothing for the render's abort or a thrown redirect Response", async () => {
    const abort = new Error(
      "The render was aborted by the server without a reason.",
    );

    renderFlight([abort, redirect("/elsewhere")]);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(consoleError).not.toHaveBeenCalled();
  });

  it("prints nothing for an AbortError once the request was aborted (a client disconnect)", async () => {
    const controller = new AbortController();
    controller.abort();

    renderFlight([abortError()], controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(consoleError).not.toHaveBeenCalled();
  });
});
