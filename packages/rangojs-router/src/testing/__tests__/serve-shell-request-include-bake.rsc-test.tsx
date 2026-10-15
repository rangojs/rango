/**
 * Issue #1179: a page mounted through include() under a layout with
 * `loader(Def, { ssr: false })` or `loading(fallback, { ssr: false })` gets
 * the document semantics of both, like the same page declared directly under
 * the layout. include() captures the layout on an evaluation without isSSR;
 * a document request used that capture as is, so a ppr capture took the
 * layout's ssr: false loader for a live one and masked it, and a document
 * showed the ssr: false fallback.
 *
 * In an app, a chrome that read the masked loader outside <Suspense> made the
 * capture postpone above <body>, so the included page stayed on MISS forever.
 * serveShellRequest has no HTML step (see its JSDoc), so here the capture
 * still stores a shell; the masked loader shows as a HIT that runs it again
 * and serves the HIT's value, where the direct page serves the value the
 * capture baked. The root postpone is pinned by e2e/ppr-include-bake.test.ts
 * in both apps.
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

import { resetShellTestState } from "../flight.entry.js";
import { createLoader, createRouter, urls } from "../../index.rsc.js";
import { shellHarness, source } from "./fixtures/shell-request-data.js";
import group from "./fixtures/prefetch-false-client-urls.js";

/** Body runs of ChromeLoader, across tests. */
const runs = { chrome: 0 };

const ChromeLoader = createLoader(async () => {
  runs.chrome += 1;
  return { chrome: `chrome@g${source.generation}` };
});

function StoreLayout(): React.ReactNode {
  return <header>store</header>;
}

function Page(): React.ReactNode {
  return <p>page</p>;
}

const sectionUrls = urls(({ path }) => [
  path("/page", Page, { name: "page", ppr: true }),
]);

const router = createRouter({}).routes(
  urls(({ layout, loader, path, include }) => [
    layout(StoreLayout, () => [
      loader(ChromeLoader, { ssr: false }),
      path("/direct", Page, { name: "direct", ppr: true }),
      include("/section", sectionUrls, { name: "section" }),
    ]),
  ]),
);

const plainSectionUrls = urls(({ path }) => [
  path("/page", Page, { name: "page" }),
]);

/**
 * The same tree without ppr, with an ssr: false loading() on the layout, and
 * a clientUrls() group (it mounts only through include()) under the layout.
 */
const fallbackRouter = createRouter({}).routes(
  urls(({ layout, loader, loading, path, include }) => [
    path("/other", () => <p>other</p>, { name: "other" }),
    layout(StoreLayout, () => [
      loader(ChromeLoader, { ssr: false }),
      loading(<p>store fallback</p>, { ssr: false }),
      path("/direct", Page, { name: "direct" }),
      include("/section", plainSectionUrls, { name: "section" }),
      include("/cu", group, { name: "cu" }),
    ]),
  ]),
);

beforeEach(async () => {
  source.generation = 1;
  await resetShellTestState();
});

describe("serveShellRequest: a layout's ssr: false loader and loading() above include() (#1179)", () => {
  it.each([
    ["declared directly under the layout", "/direct"],
    ["mounted through include() under the layout", "/section/page"],
  ])(
    "a ppr page %s goes MISS then HIT, and the HIT serves the loader value the capture baked without running it",
    async (_label, url) => {
      const { serve } = shellHarness(router);

      const miss = await serve(url);
      expect(miss.shellStatus).toBe("MISS");
      expect(miss.flight).toContain("chrome@g1");
      const runsAfterCapture = runs.chrome;

      source.generation = 2;
      const hit = await serve(url);

      expect(hit.shellStatus).toBe("HIT");
      expect(hit.flight).toContain("chrome@g1");
      expect(hit.flight).not.toContain("chrome@g2");
      expect(runs.chrome).toBe(runsAfterCapture);
    },
  );

  it.each([
    ["declared directly under the layout", "/direct"],
    ["mounted through include() under the layout", "/section/page"],
    ["of a clientUrls() group under the layout", "/cu"],
  ])(
    "a page %s renders its document without the layout's ssr: false fallback; a navigation keeps it",
    async (_label, url) => {
      const { serve } = shellHarness(fallbackRouter);

      const doc = await serve(url);
      expect(doc.flight).toContain("chrome@g1");
      expect(doc.flight).not.toContain("store fallback");

      const nav = await serve(url, { partial: { from: "/other" } });
      expect(nav.flight).toContain("store fallback");
    },
  );
});
