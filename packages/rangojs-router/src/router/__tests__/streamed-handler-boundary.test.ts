import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { runWithRouterContext } from "../router-context";
import {
  resolveSegment,
  resolveParallelSegmentsWithRevalidation,
  resolveEntryHandlerWithRevalidation,
} from "../segment-resolution";
import { DataNotFoundError } from "../../errors";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";
import {
  createContext,
  createDeps,
  entryBase,
  parallelEntry,
  routeEntry,
  routerCtx,
} from "./streamed-handler-fixtures.js";

const ERROR_FALLBACK = createElement("p", null, "declared error fallback");
const NOT_FOUND_FALLBACK = createElement("p", null, "declared not found");

function newRequestContext(ctx = createContext()) {
  return createRequestContext({
    env: {},
    request: ctx.request,
    url: ctx.url,
    variables: {},
  } as any);
}

const reject = (reason: unknown) => routeEntry(() => Promise.reject(reason));

/** Resolve a route; the component is boxed so awaiting does not flatten it. */
async function resolveRoute(
  entry: any,
  deps: any,
  options?: { throwOnError?: boolean },
) {
  const ctx = createContext();
  const reqCtx = newRequestContext(ctx);
  const box = await runWithRequestContext(reqCtx, () =>
    runWithRouterContext(routerCtx, async () => {
      const segments = await resolveSegment(
        entry,
        "r",
        {},
        ctx,
        new Map(),
        deps,
        false,
        options,
      );
      return { component: segments.find((s) => s.type === "route")!.component };
    }),
  );
  return { component: box.component as any, reqCtx };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("streamed handler renders the declared boundary", () => {
  it("renders the declared errorBoundary in place of a rejecting route handler", async () => {
    const deps = createDeps({ error: ERROR_FALLBACK });
    const { component } = await resolveRoute(reject(new Error("boom")), deps);
    expect(component).toBeInstanceOf(Promise);
    expect(await component).toBe(ERROR_FALLBACK);
  });

  it("calls a function boundary with the error info", async () => {
    const fallback = vi.fn(({ error }: any) =>
      createElement("p", null, error.message),
    );
    const deps = createDeps({ error: fallback });
    const { component } = await resolveRoute(reject(new Error("boom")), deps);
    await component;
    expect(fallback.mock.calls[0][0].error).toMatchObject({
      message: "boom",
      segmentId: "R0",
      segmentType: "route",
    });
  });

  it("reports onError once and records the failure on the request", async () => {
    const deps = createDeps({ error: ERROR_FALLBACK });
    const error = new Error("boom");
    const { component, reqCtx } = await resolveRoute(reject(error), deps);
    await component;
    await settle();
    expect(deps.callOnError).toHaveBeenCalledTimes(1);
    expect(reqCtx._recoveredHandlerErrors!.get("R0")).toBe(error);
    expect(reqCtx._renderErrors).toEqual([error]);
  });

  it("renders the notFoundBoundary for notFound() and reports once", async () => {
    const deps = createDeps({ notFound: NOT_FOUND_FALLBACK });
    const { component } = await resolveRoute(
      reject(new DataNotFoundError("nope")),
      deps,
    );
    expect(await component).toBe(NOT_FOUND_FALLBACK);
    await settle();
    expect(deps.callOnError).toHaveBeenCalledTimes(1);
  });

  it("passes notFound info to a function notFoundBoundary", async () => {
    const fallback = vi.fn(({ notFound }: any) =>
      createElement("p", null, notFound.message),
    );
    const deps = createDeps({ notFound: fallback });
    const { component } = await resolveRoute(
      reject(new DataNotFoundError("nope")),
      deps,
    );
    await component;
    expect(fallback.mock.calls[0][0].notFound).toMatchObject({
      message: "nope",
      segmentId: "R0",
      pathname: "/test",
    });
  });

  it("uses the router-level notFound option when no boundary is declared", async () => {
    const deps = createDeps({ notFoundComponent: NOT_FOUND_FALLBACK });
    const { component } = await resolveRoute(
      reject(new DataNotFoundError("nope")),
      deps,
    );
    expect(await component).toBe(NOT_FOUND_FALLBACK);
  });

  it("a resolving handler is untouched", async () => {
    const node = createElement("p", null, "ok");
    const deps = createDeps({ error: ERROR_FALLBACK });
    const { component, reqCtx } = await resolveRoute(
      routeEntry(async () => node),
      deps,
    );
    expect(await component).toBe(node);
    expect(reqCtx._recoveredHandlerErrors?.size ?? 0).toBe(0);
  });
});

describe("streamed handler keeps rejecting when there is nothing to recover to", () => {
  it("with no boundary the tracked promise is returned as is, and onError fires once", async () => {
    const error = new Error("boom");
    const deps = createDeps();
    const { component } = await resolveRoute(reject(error), deps);
    expect(component).toBe(deps.trackHandler.mock.results[0].value);
    await expect(component).rejects.toBe(error);
    await settle();
    expect(deps.callOnError).toHaveBeenCalledTimes(1);
  });

  it("notFound() with no notFound boundary or option still rejects", async () => {
    const error = new DataNotFoundError("nope");
    const deps = createDeps({ error: ERROR_FALLBACK });
    const { component } = await resolveRoute(reject(error), deps);
    await expect(component).rejects.toBe(error);
  });

  it("a rejected Response (redirect) is left unchanged", async () => {
    const redirect = new Response(null, {
      status: 302,
      headers: { Location: "/x" },
    });
    const deps = createDeps({ error: ERROR_FALLBACK });
    const { component, reqCtx } = await resolveRoute(reject(redirect), deps);
    await expect(component).rejects.toBe(redirect);
    expect(reqCtx._recoveredHandlerErrors?.size ?? 0).toBe(0);
  });

  it("a Skip is never recovered", async () => {
    const skip = Object.assign(new Error("skip"), { name: "Skip" });
    const deps = createDeps({ error: ERROR_FALLBACK });
    const { component, reqCtx } = await resolveRoute(reject(skip), deps);
    await expect(component).rejects.toBe(skip);
    expect(reqCtx._recoveredHandlerErrors?.size ?? 0).toBe(0);
  });

  it("a throwing boundary rethrows the original error and records nothing", async () => {
    const error = new Error("boom");
    const deps = createDeps({
      error: () => {
        throw new Error("fallback broke");
      },
    });
    const { component, reqCtx } = await resolveRoute(reject(error), deps);
    await expect(component).rejects.toBe(error);
    expect(reqCtx._recoveredHandlerErrors?.size ?? 0).toBe(0);
  });

  it("throwOnError (prerender) is never recovered", async () => {
    const error = new Error("boom");
    const deps = createDeps({ error: ERROR_FALLBACK });
    const { component, reqCtx } = await resolveRoute(reject(error), deps, {
      throwOnError: true,
    });
    await expect(component).rejects.toBe(error);
    expect(reqCtx._recoveredHandlerErrors?.size ?? 0).toBe(0);
  });
});

describe("parallel slots resolve the boundary from the owning entry", () => {
  const ANCESTOR = createElement("p", null, "ancestor error fallback");
  const owner = () =>
    entryBase({
      id: "l",
      type: "layout",
      shortCode: "L0",
      handler: "layout",
      errorBoundary: [ANCESTOR],
    });
  const failing = () => parallelEntry(() => Promise.reject(new Error("slot")));

  it("fresh: an ancestor errorBoundary covers a slot with loading()", async () => {
    const deps = createDeps({ real: true });
    const ctx = createContext();
    const slotOwner = owner();
    const reqCtx = newRequestContext(ctx);
    slotOwner.parallel = [failing()];
    const segments = await runWithRequestContext(reqCtx, () =>
      runWithRouterContext(routerCtx, () =>
        resolveSegment(slotOwner, "r", {}, ctx, new Map(), deps),
      ),
    );
    const seg = segments.find((s) => s.type === "parallel")!;
    expect(await seg.component).toBe(ANCESTOR);
    await settle();
    expect(deps.callOnError).toHaveBeenCalledTimes(1);
    expect(reqCtx._recoveredHandlerErrors?.size).toBe(1);
  });

  it("revalidation: an ancestor errorBoundary covers a slot with loading()", async () => {
    const deps = createDeps({ real: true });
    const ctx = createContext();
    const slotOwner = owner();
    slotOwner.parallel = [failing()];
    const result = await runWithRequestContext(newRequestContext(ctx), () =>
      runWithRouterContext(routerCtx, () =>
        resolveParallelSegmentsWithRevalidation(
          slotOwner,
          {},
          ctx,
          false,
          new Set<string>(),
          {},
          ctx.request,
          ctx.url,
          ctx.url,
          "r",
          deps,
        ),
      ),
    );
    const seg = result.segments.find((s) => s.type === "parallel")!;
    expect(await seg.component).toBe(ANCESTOR);
  });

  it("revalidation route (client navigation) renders the declared boundary", async () => {
    const deps = createDeps({ error: ERROR_FALLBACK });
    const ctx = createContext();
    const result = await runWithRequestContext(newRequestContext(ctx), () =>
      runWithRouterContext(routerCtx, () =>
        resolveEntryHandlerWithRevalidation(
          reject(new Error("boom")),
          {},
          ctx,
          true,
          new Set<string>(),
          {},
          ctx.request,
          ctx.url,
          ctx.url,
          "r",
          deps,
        ),
      ),
    );
    expect(await result.segment.component).toBe(ERROR_FALLBACK);
    await settle();
    expect(deps.callOnError).toHaveBeenCalledTimes(1);
  });
});
