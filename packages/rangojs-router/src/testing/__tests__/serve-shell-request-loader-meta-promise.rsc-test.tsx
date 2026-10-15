/**
 * Issue #1182, through serveShellRequest: an `ssr: false` loader on a ppr
 * route pushes its title to Meta as a promise. A document MISS renders the
 * title; the stored shell does not hold it, so a HIT's HTML has none and the
 * title only arrives after hydration.
 *
 * serveShellRequest has no HTML step (see its JSDoc). What the shell's
 * `<head>` was rendered from is the capture's payload (`prelude`): SSR
 * renders `<Html.Meta />` from exactly that handle data, so `shell` below is
 * the title a HIT's HTML holds.
 *
 * `source.generation` moves from 1 (the capture) to 2 (the HIT), so a value
 * read @g1 comes from the capture and @g2 from a run on the HIT.
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
  type ServeShellRequestResult,
  type ShellRequestHandles,
} from "../flight.entry.js";
import {
  createRouter,
  Meta,
  Prerender,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import { withoutPushedBy } from "../../handles/pushed-by.js";
import { shellHarness, source } from "./fixtures/shell-request-data.js";
import {
  AwaitedGridLoader,
  ChromeLoader,
  DeferTitleLoader,
  DependentGridLoader,
  GridLoader,
  HoleTitleLoader,
  metaRuns,
  NestedSideLoader,
  NestedTitleLoader,
  RecipeGridLoader,
  RecipeTitleLoader,
  RejectingTitleLoader,
  SLOW_TITLE_CAPTURE_TIMEOUT_MS,
  SlowTitleLoader,
} from "./fixtures/loader-meta-promise-data.js";
import group from "./fixtures/loader-meta-promise-client-urls.js";

function StoreLayout(): React.ReactNode {
  return <header>store</header>;
}

function Page(): React.ReactNode {
  return <p>category</p>;
}

/** A handler that pushes its title as a promise (control: baked). */
function HandlerTitlePage(ctx: HandlerContext): React.ReactNode {
  ctx.use(Meta)(
    Promise.resolve({ title: `handler-title@g${source.generation}` }),
  );
  return <p>handler</p>;
}

const sectionUrls = urls(({ path, loader }) => [
  path("/c/:id", Page, { name: "category", ppr: true }, () => [
    loader(GridLoader, { ssr: false }),
  ]),
  path("/a/:id", Page, { name: "awaited", ppr: true }, () => [
    loader(AwaitedGridLoader, { ssr: false }),
  ]),
]);

const router = createRouter({}).routes(
  urls(({ layout, loader, path, include }) => [
    path("/other", () => <p>other</p>, { name: "other" }),
    path(
      "/pre-grid",
      Prerender(() => <p>pre grid</p>),
      { name: "preGrid", ppr: { ttl: 300, swr: 120 } },
      () => [loader(GridLoader, { ssr: false })],
    ),
    layout(StoreLayout, () => [
      loader(ChromeLoader, { ssr: false }),
      path("/direct/c/:id", Page, { name: "directCategory", ppr: true }, () => [
        loader(GridLoader, { ssr: false }),
      ]),
      path("/direct/a/:id", Page, { name: "directAwaited", ppr: true }, () => [
        loader(AwaitedGridLoader, { ssr: false }),
      ]),
      path("/direct/h", HandlerTitlePage, {
        name: "directHandler",
        ppr: true,
      }),
      path("/recipe/c/:id", Page, { name: "recipe", ppr: true }, () => [
        loader(RecipeGridLoader, { ssr: false }),
        loader(RecipeTitleLoader, { ssr: false }),
      ]),
      include("/section", sectionUrls, { name: "section" }),
      include("/cu", group, { name: "cu" }),
      // The target design's cases (dc-t87).
      path("/t/reject/:id", Page, { name: "tReject", ppr: true }, () => [
        loader(RejectingTitleLoader, { ssr: false }),
      ]),
      path(
        "/t/slow/:id",
        Page,
        {
          name: "tSlow",
          ppr: { captureTimeout: SLOW_TITLE_CAPTURE_TIMEOUT_MS },
        },
        () => [loader(SlowTitleLoader, { ssr: false })],
      ),
      path("/t/nested/:id", Page, { name: "tNested", ppr: true }, () => [
        loader(NestedTitleLoader, { ssr: false }),
      ]),
      path("/t/hole/:id", Page, { name: "tHole", ppr: true }, () => [
        loader(HoleTitleLoader, { ssr: false }),
      ]),
      path("/t/two/:id", Page, { name: "tTwo", ppr: true }, () => [
        loader(GridLoader, { ssr: false }),
        loader(NestedSideLoader, { ssr: false }),
      ]),
      path("/t/defer/:id", Page, { name: "tDefer", ppr: true }, () => [
        loader(DeferTitleLoader, { ssr: false }),
      ]),
      path("/t/dep/:id", Page, { name: "tDep", ppr: true }, () => [
        loader(DependentGridLoader, { ssr: false }),
      ]),
    ]),
  ]),
);

/** The `title` of every Meta descriptor in `data`, in push order. */
function titles(data: ShellRequestHandles["hydration"] | undefined) {
  if (data === undefined) return undefined;
  return Object.values(data)
    .flatMap((bySegment) => Object.values(bySegment).flat())
    .flatMap((value) => {
      const title = (value as { title?: unknown } | undefined)?.title;
      return typeof title === "string" ? [title] : [];
    });
}

/**
 * The handle data a HIT's shell was rendered from: the capture's payload
 * decoded as the SSR render read it (its `handles` channel only).
 */
async function shellHandles(
  result: ServeShellRequestResult,
): Promise<ShellRequestHandles["hydration"] | undefined> {
  if (result.prelude === undefined) return undefined;
  const { metadata } = await deserializeResult<{
    metadata?: { handles?: AsyncIterable<ShellRequestHandles["hydration"]> };
  }>(result.prelude);
  let handles: ShellRequestHandles["hydration"] = {};
  for await (const data of metadata?.handles ?? []) handles = data;
  return withoutPushedBy(handles);
}

/**
 * A document's titles as the browser gets them: what its shell's `<head>`
 * was rendered from (a HIT), what the client hydrates with, and the state
 * the late channel leaves it in (undefined when nothing arrived late).
 */
async function documentTitles(result: ServeShellRequestResult) {
  const handles = (await result.readHandles())!;
  return {
    shell: titles(await shellHandles(result)),
    hydration: titles(handles.hydration)!,
    afterHydration: titles(handles.late.at(-1)),
  };
}

/** The titles a navigation leaves the client with (its last streamed state). */
async function navigationTitles(result: ServeShellRequestResult) {
  const handles = (await result.readHandles())!;
  return titles(handles.late.at(-1) ?? handles.hydration);
}

/** Capture `url` at generation 1, then serve its HIT at generation 2. */
async function hitAfterCapture(url: string) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { serve } = shellHarness(router);
  const miss = await serve(url);
  expect(miss.shellStatus).toBe("MISS");
  const runsAfterCapture = { ...metaRuns };
  source.generation = 2;
  const hit = await serve(url);
  expect(hit.shellStatus).toBe("HIT");
  return { serve, miss, hit, runsAfterCapture };
}

beforeEach(async () => {
  source.generation = 1;
  metaRuns.grid = 0;
  metaRuns.awaited = 0;
  metaRuns.source = 0;
  metaRuns.hole = 0;
  metaRuns.dep = 0;
  metaRuns.defer = 0;
  await resetShellTestState();
  vi.restoreAllMocks();
});

const MOUNTS = [
  ["declared directly under the layout", "/direct"],
  ["mounted through include() under the layout", "/section"],
  ["of a clientUrls() group mounted through include()", "/cu"],
] as const;

describe("#1182: an ssr: false loader's promise push to Meta on a ppr route", () => {
  describe.each(MOUNTS)("a page %s", (_label, base) => {
    const url = `${base}/c/1`;

    it("a document MISS hydrates with the title, resolved", async () => {
      const { serve } = shellHarness(router);

      const miss = await serve(url);

      expect(miss.shellStatus).toBe("MISS");
      expect((await documentTitles(miss)).hydration).toEqual(["grid-title@g1"]);
    });

    it("the issue's expectation (red): the shell keeps the title the MISS rendered, and the HIT hydrates with it", async () => {
      const { hit } = await hitAfterCapture(url);

      const { shell, hydration } = await documentTitles(hit);

      expect(shell).toEqual(["grid-title@g1"]);
      expect(hydration).toEqual(["grid-title@g1"]);
    });

    it("today: the shell has no title; the HIT's own run delivers its title after hydration, next to the grid data the capture pinned", async () => {
      const { hit, runsAfterCapture } = await hitAfterCapture(url);

      expect(await documentTitles(hit)).toEqual({
        shell: [],
        hydration: [],
        afterHydration: ["grid-title@g2"],
      });
      // The data is the capture's pin; the body ran again for the push.
      expect(hit.flight).toContain("grid@g1");
      expect(hit.flight).not.toContain("grid@g2");
      expect(metaRuns.grid).toBe(runsAfterCapture.grid + 1);
    });

    it("today: a navigation that replays the shell shows the capture's grid data with the run's title", async () => {
      const { serve } = await hitAfterCapture(url);
      const runsBefore = metaRuns.grid;

      const nav = await serve(url, { partial: { from: "/other" } });

      expect(nav.flight).toContain("grid@g1");
      expect(nav.flight).not.toContain("grid@g2");
      expect(await navigationTitles(nav)).toEqual(["grid-title@g2"]);
      expect(metaRuns.grid).toBe(runsBefore + 1);
    });

    it("a client navigation with no shell runs the loader and streams its title", async () => {
      const { serve } = shellHarness(router);

      const nav = await serve(url, { partial: { from: "/other" } });

      expect(nav.flight).toContain("grid@g1");
      expect(await navigationTitles(nav)).toEqual(["grid-title@g1"]);
    });

    it("target (red): the HIT hydrates with the capture's title next to the capture's grid, nothing arrives after hydration, and no loader body runs", async () => {
      const { hit, runsAfterCapture } = await hitAfterCapture(url);

      expect(await documentTitles(hit)).toEqual({
        shell: ["grid-title@g1"],
        hydration: ["grid-title@g1"],
        afterHydration: undefined,
      });
      expect(hit.flight).toContain("grid@g1");
      expect(hit.flight).not.toContain("grid@g2");
      expect(hit.flight).not.toContain("grid-title@g2");
      expect(metaRuns.grid).toBe(runsAfterCapture.grid);
    });

    it("target (red): a navigation that replays the shell shows the capture's title next to the capture's grid, and no loader body runs", async () => {
      const { serve } = await hitAfterCapture(url);
      const runsBefore = metaRuns.grid;

      const nav = await serve(url, { partial: { from: "/other" } });

      expect(nav.flight).toContain("grid@g1");
      expect(await navigationTitles(nav)).toEqual(["grid-title@g1"]);
      expect(metaRuns.grid).toBe(runsBefore);
    });

    it("control: the awaited push bakes into the shell, and the HIT does not run the loader", async () => {
      const awaitedUrl = `${base}/a/1`;
      const { hit, runsAfterCapture } = await hitAfterCapture(awaitedUrl);

      expect(await documentTitles(hit)).toEqual({
        shell: ["grid-title@g1"],
        hydration: ["grid-title@g1"],
        afterHydration: undefined,
      });
      expect(metaRuns.awaited).toBe(runsAfterCapture.awaited);
    });
  });

  it("a Prerender + ppr page: the shell has no title, the HIT's run delivers it after hydration (#1057 record)", async () => {
    const { hit } = await hitAfterCapture("/pre-grid");

    expect(await documentTitles(hit)).toEqual({
      shell: [],
      hydration: [],
      afterHydration: ["grid-title@g2"],
    });
    expect(hit.flight).toContain("grid@g1");
    expect(hit.flight).not.toContain("grid@g2");
  });

  describe("the recipe without a router change: the title from its own ssr: false loader, pushed settled", () => {
    it("the shell keeps the title, the HIT hydrates with it, and no loader body runs on the HIT", async () => {
      const { hit, runsAfterCapture } = await hitAfterCapture("/recipe/c/1");

      expect(await documentTitles(hit)).toEqual({
        shell: ["grid-title@g1"],
        hydration: ["grid-title@g1"],
        afterHydration: undefined,
      });
      expect(hit.flight).toContain("grid@g1");
      expect(hit.flight).not.toContain("grid@g2");
      expect(metaRuns.source).toBe(runsAfterCapture.source);
    });

    it("a navigation that replays the shell keeps the captured title next to the captured grid", async () => {
      const { serve } = await hitAfterCapture("/recipe/c/1");
      const runsBefore = metaRuns.source;

      const nav = await serve("/recipe/c/1", { partial: { from: "/other" } });

      expect(nav.flight).toContain("grid@g1");
      expect(await navigationTitles(nav)).toEqual(["grid-title@g1"]);
      expect(metaRuns.source).toBe(runsBefore);
    });

    it("a client navigation with no shell runs the source once and streams the title", async () => {
      const { serve } = shellHarness(router);

      const nav = await serve("/recipe/c/1", { partial: { from: "/other" } });

      expect(nav.flight).toContain("grid@g1");
      expect(await navigationTitles(nav)).toEqual(["grid-title@g1"]);
    });
  });

  it("control: a handler's promise push to Meta bakes into the shell", async () => {
    const { hit } = await hitAfterCapture("/direct/h");

    expect(await documentTitles(hit)).toEqual({
      shell: ["handler-title@g1"],
      hydration: ["handler-title@g1"],
      afterHydration: undefined,
    });
  });
});

/**
 * The target design (dc-t87): on a document request the handle values an
 * `ssr: false` loader pushes, settled or promise, are resolved before the
 * first flush, and a shell stores and serves exactly the resolved values its
 * capture's document rendered. A pushed promise is judged by its settled
 * value, as `push(await promise)` would be: one that holds a promise stays
 * live. One that rejects, or does not settle within ppr.captureTimeout,
 * refuses the capture, as a handler's does.
 */
describe("#1182 target: the shell keeps the resolved values of an ssr: false loader's promise pushes", () => {
  it("target (red): a Prerender + ppr page's shell keeps the title in its #1057 record, and the HIT sends nothing after hydration", async () => {
    const { hit } = await hitAfterCapture("/pre-grid");

    expect(await documentTitles(hit)).toEqual({
      shell: ["grid-title@g1"],
      hydration: ["grid-title@g1"],
      afterHydration: undefined,
    });
    expect(hit.flight).toContain("grid@g1");
    expect(hit.flight).not.toContain("grid-title@g2");
  });

  it("target (red): a promise push that rejects refuses the capture; the MISS renders the data without the title", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { serve } = shellHarness(router);

    const miss = await serve("/t/reject/1");

    expect(miss.shellStatus).toBe("MISS");
    expect(miss.flight).toContain("grid@g1");
    expect((await documentTitles(miss)).hydration).toEqual([]);
    expect((await serve("/t/reject/1")).shellStatus).not.toBe("HIT");
  });

  it("target (red): a promise push that settles after ppr.captureTimeout refuses the capture, as a handler's does; the MISS waits for it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { serve } = shellHarness(router);

    const miss = await serve("/t/slow/1");

    expect(miss.shellStatus).toBe("MISS");
    expect((await documentTitles(miss)).hydration).toEqual(["grid-title@g1"]);
    expect((await serve("/t/slow/1")).shellStatus).not.toBe("HIT");
  });

  it("unchanged: a pushed promise that settles to a value holding a promise stays live, out of the shell, from the HIT's run after hydration", async () => {
    const { hit } = await hitAfterCapture("/t/nested/1");

    expect(await documentTitles(hit)).toEqual({
      shell: [],
      hydration: [],
      afterHydration: ["grid-title@g2"],
    });
  });

  it("target (red): a loader whose data holds a hole runs on every HIT; its title stays the capture's and shows once", async () => {
    const { hit, runsAfterCapture } = await hitAfterCapture("/t/hole/1");

    const { shell, hydration, afterHydration } = await documentTitles(hit);
    expect(shell).toEqual(["grid-title@g1"]);
    expect(hydration).toEqual(["grid-title@g1"]);
    expect(afterHydration ?? hydration).toEqual(["grid-title@g1"]);
    // The body ran for the hole; the grid is the pin's.
    expect(metaRuns.hole).toBe(runsAfterCapture.hole + 1);
    expect(hit.flight).toContain("grid@g1");
    expect(hit.flight).toContain("reviews@g2");
  });

  it("target (red): another loader's unrecordable push makes every loader run on the HIT (runs: 1); the title stays the capture's and shows once", async () => {
    const { hit } = await hitAfterCapture("/t/two/1");

    const { shell, hydration, afterHydration } = await documentTitles(hit);
    expect(shell).toEqual(["grid-title@g1"]);
    expect(hydration).toEqual(["grid-title@g1"]);
    expect(afterHydration ?? hydration).toEqual(["grid-title@g1"]);
    expect(hit.flight).toContain("grid@g1");
    expect(hit.flight).not.toContain("grid@g2");
  });

  it("target (red): a .defer() slot the loader resolves after it returned bakes into the shell, and the HIT runs no loader body", async () => {
    const { hit, runsAfterCapture } = await hitAfterCapture("/t/defer/1");

    expect(await documentTitles(hit)).toEqual({
      shell: ["grid-title@g1"],
      hydration: ["grid-title@g1"],
      afterHydration: undefined,
    });
    expect(metaRuns.defer).toBe(runsAfterCapture.defer);
  });

  it("target (red): a dependency no route registers pushes the title as a promise: it bakes, and the HIT runs neither body", async () => {
    const { hit, runsAfterCapture } = await hitAfterCapture("/t/dep/1");

    expect(await documentTitles(hit)).toEqual({
      shell: ["grid-title@g1"],
      hydration: ["grid-title@g1"],
      afterHydration: undefined,
    });
    expect(hit.flight).toContain("grid@g1");
    expect(metaRuns.dep).toBe(runsAfterCapture.dep);
  });
});
