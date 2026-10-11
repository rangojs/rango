/**
 * `loader(Def, { prefetch: false })` on `clientUrls()` routes through a public
 * primitive: a group route's prefetch defers its flagged loaders, the fill
 * runs only them, and the loading() flags around a group stay inert
 * (docs/design/prefetch-false.md, R8 and "`clientUrls()` routes").
 *
 * The group is mounted as an app mounts it: include() receives the client
 * reference of a "use client" module, and its projection is installed under
 * that reference, as discovery installs it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import {
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestOptions,
  type ServeShellRequestResult,
} from "../flight.entry.js";
import { createLoader, createRouter, urls } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { clientUrls } from "../../client-urls/client-urls.js";
import {
  serializeClientUrlPatterns,
  setClientUrlProjection,
  type ClientUrlReference,
} from "../../client-urls/server-projection.js";
import PrefetchFalseClientUrls from "./fixtures/prefetch-false-client-urls.js";

const runs: Record<string, number> = {};
const ran = (name: string): number => (runs[name] = (runs[name] ?? 0) + 1);
const count = (name: string): number => runs[name] ?? 0;
const resetRuns = (): void => {
  for (const key of Object.keys(runs)) delete runs[key];
};

function counted(name: string) {
  return createLoader(async () => ({ value: `${name}-run-${ran(name)}` }));
}

function page(name: string) {
  return (): React.ReactNode => <p>{`${name}-run-${ran(name)}`}</p>;
}

const PriceLoader = counted("price");
const ReviewsLoader = counted("reviews");
const ItemLoader = counted("item");
const ShellLoader = counted("cu-shell");
const DetailLoader = counted("detail");
const ModalLoader = counted("modal");
const AboveLoader = counted("above-loader");

function CuHome(): null {
  return null;
}
function CuLoaderPage(): null {
  return null;
}
function CuItem(): null {
  return null;
}
function CuLayout(): null {
  return null;
}
function CuInLayout(): null {
  return null;
}
function CuDetail(): null {
  return null;
}
function CuModal(): null {
  return null;
}

const definition = clientUrls(
  ({ path, layout, loader, loading, intercept }) => [
    path("/", CuHome, { name: "index" }),
    path("/loader", CuLoaderPage, { name: "loader" }, () => [
      loader(PriceLoader),
      loader(ReviewsLoader, { prefetch: false }),
      loading("cu-loading"),
    ]),
    path("/item/:id", CuItem, { name: "item" }, () => [
      loader(ItemLoader, { prefetch: false }),
    ]),
    layout(CuLayout, () => [
      loader(ShellLoader, { prefetch: false }),
      path("/in-layout", CuInLayout, { name: "inLayout" }),
    ]),
    path("/detail/:id", CuDetail, { name: "detail" }, () => [
      loader(DetailLoader),
    ]),
    intercept("@modal", ".detail", CuModal, () => [
      loader(ModalLoader, { prefetch: false }),
    ]),
  ],
);

// On the server this import is a client reference (rangoUseClientTransform).
// include() is typed for the definition it stands for, as in an app.
const reference = PrefetchFalseClientUrls as unknown as ClientUrlReference;
setClientUrlProjection(reference, serializeClientUrlPatterns(definition));
const group = reference as unknown as typeof definition;

const errors: string[] = [];

const router = createRouter({
  onError: ({ error }) => {
    errors.push(error instanceof Error ? error.message : String(error));
  },
}).routes(
  urls(({ path, layout, loader, loading, include }) => [
    layout(page("shell"), () => [
      path("/", page("home"), { name: "home" }),
      // A server layout above the group, with a flagged loader and a flagged
      // loading(), and a server route beside the group under it (control).
      layout(page("above"), () => [
        loader(AboveLoader, { prefetch: false }),
        loading(<p>above-loading</p>, { prefetch: false }),
        include("/cu", group, { name: "cu" }),
        path("/beside", page("beside"), { name: "beside" }),
      ]),
    ]),
  ]),
);

type Wire = {
  id: string;
  type: string;
  deferred?: boolean;
  component?: unknown;
  loaderData?: unknown;
  clientGroup?: string;
};

function payloadOf(result: ServeShellRequestResult) {
  const row = result.flight?.split("\n").find((line) => line.startsWith("0:"));
  expect(row, "a Flight payload").toBeDefined();
  const { segments, matched } = JSON.parse(row!.slice(2)).metadata as {
    segments: Wire[];
    matched: string[];
  };
  return {
    segments,
    matched,
    ids: segments.map((segment) => segment.id),
    deferred: segments.filter((s) => s.deferred === true).map((s) => s.id),
    find(suffix: string): Wire | undefined {
      return segments.find((segment) => segment.id.endsWith(suffix));
    },
  };
}

const present = (value: unknown): boolean =>
  value !== null && value !== undefined && value !== "$undefined";

function setup() {
  const cacheStore = new MemorySegmentCacheStore();
  const serve = (
    url: string,
    extra: Omit<ServeShellRequestOptions, "cacheStore"> = {},
  ) => serveShellRequest(router, url, { cacheStore, ...extra });
  /** The segment ids a page holds after a navigation to it; runs reset. */
  const standingOn = async (at: string): Promise<string[]> => {
    const { matched } = payloadOf(await serve(at, { partial: { from: "/" } }));
    resetRuns();
    return matched;
  };
  const prefetch = (url: string, from: string, segments: string[]) =>
    serve(url, { partial: { from, segments, prefetch: true } });
  const fill = (url: string, prefetched: ReturnType<typeof payloadOf>) =>
    serve(url, {
      partial: {
        from: url,
        segments: prefetched.matched.filter(
          (id) => !prefetched.deferred.includes(id),
        ),
        fill: true,
      },
    });
  return { serve, standingOn, prefetch, fill };
}

beforeEach(async () => {
  resetRuns();
  errors.length = 0;
  await resetShellTestState();
});

describe("clientUrls() routes: loader(Def, { prefetch: false })", () => {
  it("an in-group prefetch defers the flagged loader, runs its sibling once and answers source-scoped", async () => {
    const { standingOn, prefetch } = setup();
    const held = await standingOn("/cu");

    const result = await prefetch("/cu/loader", "/cu", held);
    const payload = payloadOf(result);
    expect({ price: count("price"), reviews: count("reviews") }).toEqual({
      price: 1,
      reviews: 0,
    });
    const reviews = payload.find(ReviewsLoader.$$id)!;
    expect(reviews).toMatchObject({ type: "loader", deferred: true });
    expect("loaderData" in reviews).toBe(false);
    expect(present(payload.find(PriceLoader.$$id)!.loaderData)).toBe(true);
    // The group segment renders: its handler is ClientUrlsRoot.
    const route = payload.segments.find((s) => s.type === "route")!;
    expect(route.clientGroup).toBe("/cu");
    expect(route.deferred).toBeUndefined();
    expect(await result.readDeferred()).toEqual([reviews.id]);
    expect(result.response.headers.get("cache-control")).toBe(
      "private, no-cache",
    );
    expect(result.response.headers.get("x-rsc-prefetch-scope")).toBe("source");
    expect(errors).toEqual([]);
  });

  it("its fill emits only the flagged loader's segment and runs it once", async () => {
    const { standingOn, prefetch, fill } = setup();
    const held = await standingOn("/cu");
    const prefetched = payloadOf(await prefetch("/cu/loader", "/cu", held));
    resetRuns();

    const result = await fill("/cu/loader", prefetched);
    const payload = payloadOf(result);
    expect(runs).toEqual({ reviews: 1 });
    expect(payload.ids).toEqual(prefetched.deferred);
    expect(present(payload.segments[0]!.loaderData)).toBe(true);
    expect(result.flight).toContain("reviews-run-1");
    expect(payload.matched).toEqual(prefetched.matched);
    expect(errors).toEqual([]);
  });

  it("a navigation with no prefetch runs it and defers nothing", async () => {
    const { standingOn, serve } = setup();
    const held = await standingOn("/cu");

    const result = await serve("/cu/loader", {
      partial: { from: "/cu", segments: held },
    });
    const payload = payloadOf(result);
    expect({ price: count("price"), reviews: count("reviews") }).toEqual({
      price: 1,
      reviews: 1,
    });
    expect(payload.deferred).toEqual([]);
    expect(present(payload.find(ReviewsLoader.$$id)!.loaderData)).toBe(true);
  });

  it("a same-route prefetch runs the flagged loader the client holds and defers nothing", async () => {
    const { standingOn, prefetch } = setup();
    const held = await standingOn("/cu/item/a");

    const result = await prefetch("/cu/item/b", "/cu/item/a", held);
    expect(count("item")).toBe(1);
    expect(payloadOf(result).deferred).toEqual([]);
    expect(result.flight).not.toContain('"deferred"');
  });

  it("a layout() loader with the flag is deferred on the route it flattens onto", async () => {
    const { standingOn, prefetch } = setup();
    const held = await standingOn("/cu");

    const payload = payloadOf(await prefetch("/cu/in-layout", "/cu", held));
    expect(count("cu-shell")).toBe(0);
    expect(payload.deferred).toEqual([payload.find(ShellLoader.$$id)!.id]);
  });

  it("a flagged loader on a server layout above the group is deferred while the layout is new, and a flagged loading() there defers nothing", async () => {
    const { standingOn, prefetch } = setup();
    const held = await standingOn("/");

    const payload = payloadOf(await prefetch("/cu/loader", "/", held));
    expect({
      above: count("above"),
      aboveLoader: count("above-loader"),
      price: count("price"),
      reviews: count("reviews"),
    }).toEqual({ above: 1, aboveLoader: 0, price: 1, reviews: 0 });
    expect(payload.deferred.sort()).toEqual(
      [
        payload.find(AboveLoader.$$id)!.id,
        payload.find(ReviewsLoader.$$id)!.id,
      ].sort(),
    );
    // No segment of the chain is a handler unit.
    expect(
      payload.segments.filter((s) => s.deferred && s.type !== "loader"),
    ).toEqual([]);
  });

  it("control: the server route beside the group under the same layout defers the layout as a unit", async () => {
    const { standingOn, prefetch } = setup();
    const held = await standingOn("/");

    const payload = payloadOf(await prefetch("/beside", "/", held));
    expect({ above: count("above"), beside: count("beside") }).toEqual({
      above: 0,
      beside: 0,
    });
    expect(
      payload.segments.some(
        (s) =>
          s.type === "layout" && s.deferred === true && s.component === null,
      ),
    ).toBe(true);
  });

  it("inside the group the server layout above it is held: its flagged loader is neither deferred nor run", async () => {
    const { standingOn, prefetch } = setup();
    const held = await standingOn("/cu");

    const payload = payloadOf(await prefetch("/cu/loader", "/cu", held));
    expect(count("above-loader")).toBe(0);
    expect(payload.find(AboveLoader.$$id)).toBeUndefined();
    expect(payload.deferred).toEqual([payload.find(ReviewsLoader.$$id)!.id]);
  });

  // A urls() intercept() ignores the flag (R8): a prefetch that resolves an
  // intercept defers nothing. A clientUrls() intercept() is the same.
  it("an intercept loader with the flag runs in a prefetch that resolves the intercept, as in urls()", async () => {
    const { standingOn, prefetch } = setup();
    const held = await standingOn("/cu");

    const result = await prefetch("/cu/detail/1", "/cu", held);
    expect(count("modal")).toBe(1);
    expect(payloadOf(result).deferred).toEqual([]);
    expect(result.flight).not.toContain('"deferred"');
  });
});
