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
  GridLoader,
  metaRuns,
  RecipeGridLoader,
  RecipeTitleLoader,
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
