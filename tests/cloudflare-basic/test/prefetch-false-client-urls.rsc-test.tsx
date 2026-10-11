// Dogfood: `loader(Def, { prefetch: false })` on the app's clientUrls() group
// (src/pages/prefetch-false-client-urls.tsx) through serveShellRequest. The
// router mounts the "use client" module with include(), as
// pages/prefetch-false.tsx does: here it is a client reference, and
// rangoUseClientTransform (vitest.rsc.config.ts) installs its projection, as
// the rango plugin's discovery does in the app. Runs are counted by the app's
// own counters (src/prefetch-false-counts.ts), keyed by `?run=`. dispatch
// matches the group through the same projection.
import { beforeEach, describe, expect, it } from "vitest";
import { createRouter, urls } from "@rangojs/router";
import { dispatch } from "@rangojs/router/testing";
import {
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestResult,
} from "@rangojs/router/testing/flight";
import type { AppBindings } from "../src/env.js";
import prefetchFalseClientUrls from "../src/pages/prefetch-false-client-urls.js";
import {
  PfCuPriceLoader,
  PfCuReviewsLoader,
} from "../src/pages/prefetch-false-client-urls.loader.js";
import { readRunCounts } from "../src/prefetch-false-counts.js";

const env = {} as AppBindings;

const mount = (id: string) =>
  createRouter<AppBindings>({ id }).routes(
    urls(({ include }) => [
      include("/prefetch-false/cu", prefetchFalseClientUrls, { name: "pfCu" }),
    ]),
  );

const router = mount("pf-cu");

beforeEach(() => resetShellTestState());

interface Segment {
  id: string;
  type: string;
  deferred?: boolean;
  loaderData?: unknown;
  clientGroup?: string;
}

/** The payload's segments and `metadata.matched`, from the Flight text. */
function metadataOf(result: ServeShellRequestResult): {
  segments: Segment[];
  matched: string[];
} {
  const row = result.flight?.split("\n").find((line) => line.startsWith("0:"));
  if (!row) throw new Error("no Flight payload");
  return JSON.parse(row.slice(2)).metadata;
}

const segmentOf = (segments: Segment[], loaderId: string): Segment => {
  const segment = segments.find((s) => s.id.endsWith(loaderId));
  if (!segment) throw new Error(`no segment for ${loaderId}`);
  return segment;
};

describe("prefetch: false on a clientUrls() group (cloudflare-basic)", () => {
  it("a prefetch defers only the flagged loader, and the fill runs it once", async () => {
    const run = "dogfood-cu-loader";
    const origin = `/prefetch-false/cu?run=${run}`;
    const target = `/prefetch-false/cu/loader?run=${run}`;
    const serve = (
      url: string,
      partial: {
        from: string;
        segments: string[];
        prefetch?: boolean;
        fill?: boolean;
      },
    ) => serveShellRequest(router, url, { env, partial });

    // Standing on the group's index: the segments the page holds.
    const { matched: held } = metadataOf(
      await serveShellRequest(router, origin, { env, partial: { from: "/" } }),
    );

    const prefetch = await serve(target, {
      from: origin,
      segments: held,
      prefetch: true,
    });
    expect(readRunCounts(run)).toEqual({ "cu/loader.price": 1 });
    const prefetched = metadataOf(prefetch);
    const reviews = segmentOf(prefetched.segments, PfCuReviewsLoader.$$id);
    expect(reviews).toMatchObject({ type: "loader", deferred: true });
    expect(
      segmentOf(prefetched.segments, PfCuPriceLoader.$$id).deferred,
    ).toBeUndefined();
    expect(await prefetch.readDeferred()).toEqual([reviews.id]);
    // The group's route segment renders (its handler is the group's root).
    expect(
      prefetched.segments.find((s) => s.type === "route")?.clientGroup,
    ).toBe("/prefetch-false/cu");

    const fill = await serve(target, {
      from: target,
      segments: prefetched.matched.filter((id) => id !== reviews.id),
      fill: true,
    });
    expect(readRunCounts(run)).toEqual({
      "cu/loader.price": 1,
      "cu/loader.data": 1,
    });
    const filled = metadataOf(fill);
    expect(filled.segments.map((s) => s.id)).toEqual([reviews.id]);
    expect(fill.flight).toContain('"cu/loader.data"');
    expect(await fill.readDeferred()).toEqual([]);
  });

  it("a navigation with no prefetch runs both loaders and defers nothing", async () => {
    const run = "dogfood-cu-nav";
    const origin = `/prefetch-false/cu?run=${run}`;
    const { matched: held } = metadataOf(
      await serveShellRequest(router, origin, { env, partial: { from: "/" } }),
    );

    const nav = await serveShellRequest(
      router,
      `/prefetch-false/cu/loader?run=${run}`,
      { env, partial: { from: origin, segments: held } },
    );
    expect(readRunCounts(run)).toEqual({
      "cu/loader.price": 1,
      "cu/loader.data": 1,
    });
    expect(await nav.readDeferred()).toEqual([]);
  });

  it("dispatch matches the group's routes: a trailing slash redirects, an unknown path is a 404", async () => {
    // A router no serveShellRequest call has served: once one has, dispatch
    // matches a trailing-slash URL as the route instead of redirecting it.
    const fresh = mount("pf-cu-dispatch");
    const status = async (url: string) => {
      const response = await dispatch(fresh, {
        env,
        request: new Request(`http://localhost${url}`),
      });
      return [response.status, response.headers.get("location")];
    };
    expect(await status("/prefetch-false/cu/loader/")).toEqual([
      308,
      "/prefetch-false/cu/loader",
    ]);
    expect(await status("/prefetch-false/cu/missing")).toEqual([404, null]);
  });
});
