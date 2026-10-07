/**
 * The other cache families keyed by host and path, with two routers on one
 * host and path and one cache store (issue #1065): a route `cache()` record,
 * a document-cache response and a response route's entry are each the output
 * of one router's code, so the other router must not read them.
 *
 * `MemorySegmentCacheStore` has no version in its keys, so nothing but the
 * key's router part keeps the two apart there. `CFCacheStore` and
 * `VercelCacheStore` also prefix a version, which is equal for both routers
 * under one `createRouter({ version })` or the whole-build pair.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import { dispatch } from "../index.js";
import { createRouter, urls, type HandlerContext } from "../../index.rsc.js";
import {
  MemorySegmentCacheStore,
  createDocumentCacheMiddleware,
  type SegmentCacheStore,
} from "../../cache/index.js";

const SHARED_ORIGIN = "http://shared.example";

type App = "a" | "b";

/** Handler runs per router: a served entry runs none. */
const runs: Record<App, number> = { a: 0, b: 0 };

function makeRouter(app: App, store: SegmentCacheStore) {
  return createRouter({ id: `app-${app}`, cache: { store } })
    .use("/stored", createDocumentCacheMiddleware())
    .routes(
      urls(({ path, cache }) => [
        cache({ ttl: 300 }, () => [
          path(
            "/cached",
            () => {
              runs[app] += 1;
              return <p>{`app-${app}-cached`}</p>;
            },
            { name: "cached" },
          ),
          path.json(
            "/api/data",
            () => {
              runs[app] += 1;
              return { from: `app-${app}` };
            },
            { name: "data" },
          ),
        ]),
        path(
          "/stored",
          (ctx: HandlerContext) => {
            runs[app] += 1;
            ctx.headers.set("Cache-Control", "s-maxage=60");
            return <p>{`app-${app}-stored`}</p>;
          },
          { name: "stored" },
        ),
      ]),
    );
}

function makeRouters(): Record<App, ReturnType<typeof makeRouter>> {
  const store = new MemorySegmentCacheStore();
  return { a: makeRouter("a", store), b: makeRouter("b", store) };
}

/** The page content a response text carries (not the metadata's router id). */
function contentIn(text: string): string[] {
  return [...new Set(text.match(/app-[ab]-(?:cached|stored)/g) ?? [])];
}

beforeEach(async () => {
  await resetShellTestState();
  runs.a = 0;
  runs.b = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("two routers on one host and path, one cache store: records", () => {
  it("a route cache() record is read only by the router that wrote it", async () => {
    const { a, b } = makeRouters();
    const url = `${SHARED_ORIGIN}/cached`;

    expect(contentIn((await serveShellRequest(a, url)).body)).toEqual([
      "app-a-cached",
    ]);
    expect(contentIn((await serveShellRequest(b, url)).body)).toEqual([
      "app-b-cached",
    ]);

    // Each router's own record serves its next request: no handler run.
    expect(contentIn((await serveShellRequest(a, url)).body)).toEqual([
      "app-a-cached",
    ]);
    expect(contentIn((await serveShellRequest(b, url)).body)).toEqual([
      "app-b-cached",
    ]);
    expect(runs).toEqual({ a: 1, b: 1 });
  });

  it("a navigation's cache() record is read only by the router that wrote it", async () => {
    const { a, b } = makeRouters();
    const navigate = async (router: typeof a): Promise<string[]> =>
      contentIn(
        (
          await serveShellRequest(router, `${SHARED_ORIGIN}/cached`, {
            partial: true,
          })
        ).body,
      );

    expect(await navigate(a)).toEqual(["app-a-cached"]);
    expect(await navigate(b)).toEqual(["app-b-cached"]);
    expect(runs).toEqual({ a: 1, b: 1 });
  });

  it("a document-cache response is served only by the router that stored it", async () => {
    const { a, b } = makeRouters();
    const get = async (
      router: typeof a,
    ): Promise<{ status: string | null; content: string[] }> => {
      const result = await serveShellRequest(router, `${SHARED_ORIGIN}/stored`);
      return {
        status: result.response.headers.get("x-document-cache-status"),
        content: contentIn(result.body),
      };
    };

    expect(await get(a)).toEqual({ status: "MISS", content: ["app-a-stored"] });
    expect(await get(b)).toEqual({ status: "MISS", content: ["app-b-stored"] });
    expect(await get(a)).toEqual({ status: "HIT", content: ["app-a-stored"] });
    expect(await get(b)).toEqual({ status: "HIT", content: ["app-b-stored"] });
  });

  it("a response route's cached entry is served only by the router that stored it", async () => {
    const { a, b } = makeRouters();
    const get = async (router: typeof a): Promise<unknown> => {
      const response = await dispatch(router, {
        request: new Request(`${SHARED_ORIGIN}/api/data`),
      });
      // The entry is written after the response.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return response.json();
    };

    expect(await get(a)).toEqual({ from: "app-a" });
    expect(await get(b)).toEqual({ from: "app-b" });
    expect(await get(a)).toEqual({ from: "app-a" });
    expect(await get(b)).toEqual({ from: "app-b" });
    expect(runs).toEqual({ a: 1, b: 1 });
  });
});
