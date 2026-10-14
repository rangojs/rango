/**
 * A prefetch whose render reported an error is not kept (#1170). The status
 * left with the headers, so the server ends the body cleanly with one more
 * Flight row the decoder skips, which the browser reads as a stream that did
 * not end cleanly: it evicts the prefetch and never respawns it. Prefetch
 * responses carry no Cache-Control, so the HTTP cache keeps none of it. A
 * navigation and a document of the same page end as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React, { Suspense } from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import { createLoader, createRouter, redirect, urls } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { PREFETCH_FAILED_ROW } from "../../prefetch-markers.js";

let failing = true;

const StockLoader = createLoader(async (): Promise<{ value: string }> => {
  if (failing) throw new Error("stock down");
  return { value: "in stock" };
});

const MovedLoader = createLoader(async (): Promise<{ value: string }> => {
  throw redirect("/ok");
});

async function Handler(): Promise<React.ReactNode> {
  await new Promise((r) => setTimeout(r, 5));
  if (failing) throw new Error("handler down");
  return <p>healthy-content</p>;
}

async function Child(): Promise<React.ReactNode> {
  await new Promise((r) => setTimeout(r, 5));
  if (failing) throw new Error("child down");
  return <p>child-content</p>;
}

const router = createRouter({
  id: "prefetch-render-errors",
  version: "v1",
}).routes(
  urls(({ path, loader, loading, errorBoundary }) => [
    path("/", () => <p>home</p>, { name: "home" }),
    path("/ok", () => <p>ok</p>, { name: "ok" }),
    path("/handler", Handler, { name: "handler" }, () => [
      loading(<p>loading</p>),
      errorBoundary(<p>declared-error</p>),
    ]),
    path(
      "/loader",
      () => <p>stock page</p>,
      { name: "loader" },
      () => [loader(StockLoader), loading(<p>loading</p>)],
    ),
    path(
      "/child",
      () => (
        <Suspense fallback={<p>loading</p>}>
          <Child />
        </Suspense>
      ),
      { name: "child" },
    ),
    path(
      "/moved",
      () => <p>moved page</p>,
      { name: "moved" },
      () => [loader(MovedLoader)],
    ),
  ]),
);

function serve(url: string, partial?: { prefetch: boolean }) {
  return serveShellRequest(router, url, {
    cacheStore: new MemorySegmentCacheStore(),
    ...(partial && { partial: { from: "/", ...partial } }),
  });
}

const FAILING = [
  ["a loading() handler recovered into its errorBoundary()", "/handler"],
  ["a loader that threw, rendered in place", "/loader"],
  ["an async component under <Suspense> that threw", "/child"],
] as const;

beforeEach(async () => {
  failing = true;
  await resetShellTestState();
});

describe("a prefetch whose render reported an error", () => {
  it.each(FAILING)(
    "%s: ends with the failure row, after the whole payload, with no Cache-Control",
    async (_, url) => {
      const { response, body } = await serve(url, { prefetch: true });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBeNull();
      expect(body.endsWith(PREFETCH_FAILED_ROW)).toBe(true);
      expect(body.indexOf(PREFETCH_FAILED_ROW)).toBe(
        body.length - PREFETCH_FAILED_ROW.length,
      );
    },
  );

  it("a healthy prefetch ends without it, with no Cache-Control", async () => {
    failing = false;
    for (const url of ["/handler", "/loader", "/child"]) {
      const { response, body } = await serve(url, { prefetch: true });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBeNull();
      expect(body.endsWith(PREFETCH_FAILED_ROW)).toBe(false);
    }
  });

  it("a loader redirect() is not an error: the prefetch ends without it", async () => {
    const { body } = await serve("/moved", { prefetch: true });
    expect(body.endsWith(PREFETCH_FAILED_ROW)).toBe(false);
  });
});

describe("a navigation and a document of the same page", () => {
  it.each(FAILING)("%s: end as before", async (_, url) => {
    const navigation = await serve(url, { prefetch: false });
    expect(navigation.body.endsWith(PREFETCH_FAILED_ROW)).toBe(false);
    const document = await serve(url);
    expect(document.body.endsWith(PREFETCH_FAILED_ROW)).toBe(false);
  });

  it("the navigation carries the declared boundary", async () => {
    const { body } = await serve("/handler", { prefetch: false });
    expect(body).toContain("declared-error");
  });
});
