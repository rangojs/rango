/**
 * wrapLoaderWithErrorHandling signal envelopes: notFound()/redirect() thrown
 * from a loader are control flow, not failures — they produce dedicated
 * envelope shapes (notFound: server-rendered UI riding `fallback`; redirect:
 * same-origin-resolved target), skip onError, and set the opportunistic 404
 * status on the request stub.
 */

import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { wrapLoaderWithErrorHandling } from "../loader-resolution.js";
import { notFound, DataNotFoundError } from "../../errors.js";
import { redirect } from "../../route-definition/redirect.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";
import type { EntryData } from "../../server/context";

const entry = { shortCode: "t0", type: "route" } as unknown as EntryData;

const createErrorInfo = (error: unknown, segmentId: string) =>
  ({
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : "Error",
    segmentId,
    segmentType: "loader",
  }) as any;

function wrap(
  promise: Promise<unknown>,
  opts?: {
    onError?: (error: unknown, ctx: any) => void;
    notFoundDeps?: Parameters<typeof wrapLoaderWithErrorHandling>[7];
    errorBoundary?: any;
  },
) {
  return wrapLoaderWithErrorHandling(
    promise,
    entry,
    "t0D0.test-loader",
    "/products/missing",
    () => opts?.errorBoundary ?? null,
    createErrorInfo,
    opts?.onError,
    opts?.notFoundDeps,
  );
}

function makeCtx(url = "https://shop.example/products/missing") {
  return createRequestContext({
    env: {},
    request: new Request(url),
    url: new URL(url),
    variables: {},
  });
}

describe("notFound() envelopes", () => {
  it("produces notFound:true with the nearest notFoundBoundary rendered as fallback", async () => {
    const boundary = vi.fn(({ notFound: info }: any) =>
      createElement("div", null, `404: ${info.message}`),
    );
    const result: any = await wrap(
      Promise.reject(new DataNotFoundError("Product not found")),
      {
        notFoundDeps: {
          findNearestNotFoundBoundary: () => boundary,
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.notFound).toBe(true);
    expect(boundary).toHaveBeenCalledWith({
      notFound: expect.objectContaining({
        message: "Product not found",
        segmentType: "loader",
        pathname: "/products/missing",
      }),
    });
    expect(result.fallback.props.children).toBe("404: Product not found");
    expect(result.error.name).toBe("DataNotFoundError");
  });

  it("falls back to the router notFound option, then the default node", async () => {
    const viaOption: any = await wrap(Promise.reject(notFoundThrown()), {
      notFoundDeps: {
        findNearestNotFoundBoundary: () => null,
        notFoundComponent: ({ pathname }) =>
          createElement("p", null, `gone: ${pathname}`),
      },
    });
    expect(viaOption.notFound).toBe(true);
    expect(viaOption.fallback.props.children).toBe("gone: /products/missing");

    const viaDefault: any = await wrap(Promise.reject(notFoundThrown()));
    expect(viaDefault.notFound).toBe(true);
    expect(viaDefault.fallback.type).toBe("h1");
  });

  it("matches by error NAME too (cross-realm DataNotFoundError)", async () => {
    const crossRealm = new Error("gone");
    crossRealm.name = "DataNotFoundError";
    const result: any = await wrap(Promise.reject(crossRealm));
    expect(result.notFound).toBe(true);
  });

  it("does NOT invoke onError (control flow, not failure) and sets stub status 404", async () => {
    const onError = vi.fn();
    const ctx = makeCtx();
    const result: any = await runWithRequestContext(ctx, () =>
      wrap(Promise.reject(new DataNotFoundError("nope")), { onError }),
    );
    expect(result.notFound).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(ctx.res.status).toBe(404);
  });

  it("a throwing notFound boundary degrades to the default node, never rejects", async () => {
    const result: any = await wrap(Promise.reject(notFoundThrown()), {
      notFoundDeps: {
        findNearestNotFoundBoundary: () => () => {
          throw new Error("boundary exploded");
        },
      },
    });
    expect(result.notFound).toBe(true);
    expect(result.fallback.type).toBe("h1");
  });
});

function notFoundThrown(): unknown {
  try {
    notFound("Product not found");
  } catch (e) {
    return e;
  }
}

describe("redirect() envelopes", () => {
  it("produces redirect.to resolved same-origin inside a request context", async () => {
    const ctx = makeCtx();
    const result: any = await runWithRequestContext(ctx, () =>
      wrap(Promise.reject(redirect("/products"))),
    );
    expect(result.ok).toBe(false);
    // The soft-redirect channel ships the resolved ABSOLUTE href (same
    // convention as metadata.redirect); the client navigates it same-origin.
    expect(result.redirect).toEqual({ to: "https://shop.example/products" });
    expect(result.notFound).toBeUndefined();
  });

  it("neutralizes a cross-origin target without the external opt-in", async () => {
    const ctx = makeCtx();
    const result: any = await runWithRequestContext(ctx, () =>
      wrap(Promise.reject(redirect("https://evil.example/steal"))),
    );
    // Same-origin guard lands the target on the app root, never off-host.
    expect(result.redirect.to).not.toContain("evil.example");
  });

  it("allows an http(s) cross-origin target with redirect(url, { external: true })", async () => {
    const ctx = makeCtx();
    const result: any = await runWithRequestContext(ctx, () =>
      wrap(
        Promise.reject(
          redirect("https://accounts.example/oauth", { external: true }),
        ),
      ),
    );
    expect(result.redirect.to).toBe("https://accounts.example/oauth");
  });

  it("does NOT invoke onError for redirects", async () => {
    const onError = vi.fn();
    const ctx = makeCtx();
    await runWithRequestContext(ctx, () =>
      wrap(Promise.reject(redirect("/login")), { onError }),
    );
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("plain errors keep the existing contract", () => {
  it("a non-signal rejection still routes to the error boundary and onError", async () => {
    const onError = vi.fn();
    const result: any = await wrap(Promise.reject(new Error("db down")), {
      onError,
      errorBoundary: createElement("i", null, "error-ui"),
    });
    expect(result.ok).toBe(false);
    expect(result.notFound).toBeUndefined();
    expect(result.redirect).toBeUndefined();
    expect(result.fallback.props.children).toBe("error-ui");
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
