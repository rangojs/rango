// Dogfood: `loader(Def, { prefetch: false })` inside the app's intercept()
// (src/pages/prefetch-false.tsx, the `ix` pages) through serveShellRequest.
// A prefetch of the intercept's target from its source page defers the
// flagged loader, a loader segment of the @modal slot; the fill the browser
// sends from the source, with the intercept source header, runs only that
// loader. Runs are counted by the app's own counters
// (src/prefetch-false-counts.ts), keyed by `?run=`.
import { beforeEach, describe, expect, it } from "vitest";
import { createRouter, urls } from "@rangojs/router";
import {
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestResult,
} from "@rangojs/router/testing/flight";
import type { AppBindings } from "../src/env.js";
import {
  PfIxItemLoader,
  prefetchFalsePatterns,
} from "../src/pages/prefetch-false.js";
import { readRunCounts } from "../src/prefetch-false-counts.js";

const env = {} as AppBindings;

const router = createRouter<AppBindings>({ id: "pf-ix" }).routes(
  urls(({ include }) => [
    include("/prefetch-false", prefetchFalsePatterns, {
      name: "prefetchFalse",
    }),
  ]),
);

beforeEach(() => resetShellTestState());

interface Segment {
  id: string;
  type: string;
  deferred?: boolean;
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

describe("prefetch: false inside intercept() (cloudflare-basic)", () => {
  it("a prefetch from the source defers the flagged intercept loader, and its fill runs only that loader", async () => {
    const run = "dogfood-ix";
    const source = `/prefetch-false/ix?run=${run}`;
    const target = `/prefetch-false/ix/item/1?run=${run}`;
    const { matched: held } = metadataOf(
      await serveShellRequest(router, source, { env, partial: { from: "/" } }),
    );

    const prefetch = await serveShellRequest(router, target, {
      env,
      partial: { from: source, segments: held, prefetch: true },
    });
    const prefetched = metadataOf(prefetch);
    const flagged = prefetched.segments.find((s) =>
      s.id.endsWith(PfIxItemLoader.$$id),
    )!;
    expect(flagged.id).toMatch(/\.@modalD1\./);
    expect(await prefetch.readDeferred()).toEqual([flagged.id]);
    expect(readRunCounts(run)).toMatchObject({
      "ix-item.a": 1,
      "ix-item.modal": 1,
    });
    expect(readRunCounts(run)["ix-item.data"]).toBeUndefined();

    const fill = await serveShellRequest(router, target, {
      env,
      partial: {
        from: source,
        interceptSource: source,
        segments: prefetched.matched.filter((id) => id !== flagged.id),
        fill: true,
      },
    });
    const filled = metadataOf(fill);
    expect(filled.segments.map((s) => s.id)).toEqual([flagged.id]);
    expect(filled.matched).toEqual(prefetched.matched);
    expect(readRunCounts(run)).toMatchObject({
      "ix-item.a": 1,
      "ix-item.data": 1,
      "ix-item.modal": 1,
    });
  });
});
