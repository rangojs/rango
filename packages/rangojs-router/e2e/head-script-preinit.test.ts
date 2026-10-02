import test, { expect } from "@playwright/test";
import {
  expectClientLinkNavigation,
  expectEntryHintAfterHeadChunks,
  fetchDocument,
  fizzBootstrapScript,
  headChunkScripts,
  modulepreloadHrefs,
} from "@shared/e2e";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Script-strategy e2e: client-reference chunks ship as EXECUTING
 * `<script type="module" async>` tags hoisted into <head>
 * (preinitModule upgrade of plugin-rsc's modulepreload hints), and the browser
 * entry ships as `bootstrapModules` — a head `<link rel="modulepreload">` hint
 * (default fetch priority, after the head chunk scripts, #1025) paired with
 * the executing `<script type="module" id="_R_" async>` at end of shell. See
 * src/ssr/preinit-client-references.ts and src/ssr/entry-preload-priority.ts.
 * The opt-in `fetchPriority: "low"`
 * build is covered by head-script-priority-low.test.ts.
 */

test.describe("head-script-preinit", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });

  test("dev: entry ships as a module script with a matching modulepreload hint", async () => {
    const html = await fetchDocument(f.url("/"));
    const { tag, src } = fizzBootstrapScript(html);

    // bootstrapModules conversion applies in dev too: executing module
    // script (not an inline import()) whose hint precedes it in <head>.
    expect(tag).toContain('type="module"');
    expect(modulepreloadHrefs(html)).toContain(src);
  });

  test("dev: the entry hint is at default fetch priority, in the head (#1025)", async () => {
    expectEntryHintAfterHeadChunks(await fetchDocument(f.url("/")));
  });

  test("dev: page hydrates cleanly under the module bootstrap", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/"));
    await waitForHydration(page);
  });

  test("dev: no head chunk scripts to prioritize", async () => {
    // plugin-rsc reports no JS deps per client reference in dev, so the
    // fetchpriority assertions live in the production describes. A dev
    // document that starts carrying head chunk scripts fails here first.
    expect(headChunkScripts(await fetchDocument(f.url("/")))).toEqual([]);
  });

  test("dev: a client Link navigates after hydration", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/"));
    await waitForHydration(page);
    await expectClientLinkNavigation(
      page,
      "product-link-product-a",
      "/product/product-a",
    );
  });
});

test.describe("head-script-preinit (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });

  test("head has executing module scripts for client chunks, no leftover hints", async () => {
    const html = await fetchDocument(f.url("/"));

    // Client-reference chunks are executing async module scripts in <head>.
    expect(headChunkScripts(html).length).toBeGreaterThan(0);

    // The preinit UPGRADE removed their modulepreload hints: the only
    // modulepreload left is the entry's, and it pairs with the executing
    // bootstrap at end of shell.
    const { tag, src } = fizzBootstrapScript(html);
    expect(modulepreloadHrefs(html)).toEqual([src]);
    expect(tag).toContain('type="module"');
  });

  test("the entry hint is at default fetch priority, once, after the head chunk scripts (#1025)", async () => {
    const html = await fetchDocument(f.url("/"));
    // Fizz writes this hint as fetchPriority="low" ahead of the head chunk
    // scripts; the SSR handler drops the attribute (hydration no longer
    // queues behind in-viewport images) and moves the tag after the
    // head chunk scripts (it no longer takes a connection ahead of a chunk).
    const hint = expectEntryHintAfterHeadChunks(html);
    const chunks = headChunkScripts(html);
    expect(chunks.length).toBeGreaterThan(0);
    expect(html.indexOf(hint)).toBeGreaterThan(html.indexOf(chunks.at(-1)!));
  });

  test("head chunk scripts carry no fetchpriority by default", async () => {
    const scripts = headChunkScripts(await fetchDocument(f.url("/")));
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) {
      expect(tag).not.toMatch(/\bfetchpriority=/i);
    }
  });

  test("page hydrates cleanly under the head-executing scripts", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/"));
    await waitForHydration(page);
  });

  test("a client Link navigates after hydration", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/"));
    await waitForHydration(page);
    await expectClientLinkNavigation(
      page,
      "product-link-product-a",
      "/product/product-a",
    );
  });
});
