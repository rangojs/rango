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
 * Script-strategy e2e on the Cloudflare (workerd) preset: client-reference
 * chunks ship as EXECUTING `<script type="module" async>` tags
 * hoisted into <head> (preinitModule upgrade of plugin-rsc's
 * modulepreload hints), and the browser entry ships as `bootstrapModules` — a
 * head modulepreload hint at default fetch priority, after the head chunk
 * scripts (#1025), paired with the executing
 * `<script type="module" id="_R_" async>` at end of shell.
 * Mirrors packages/rangojs-router/e2e/head-script-preinit.test.ts; the workerd
 * copy pins that the preinit path (node:async_hooks import included) loads and
 * renders in the workerd SSR environment. The nonce VALUE assertion lives in
 * tests/react-experimental/e2e/gtm.test.ts (the only CSP-wired fixture, node
 * preset) — workerd has no nonce'd fixture, a known coverage gap.
 */

test.describe("head-script-preinit (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });

  test("entry ships as a module script with a matching modulepreload hint", async () => {
    const html = await fetchDocument(f.url("/"));
    const { tag, src } = fizzBootstrapScript(html);

    expect(tag).toContain('type="module"');
    expect(modulepreloadHrefs(html)).toContain(src);
  });

  test("the entry hint is at default fetch priority, in the head (#1025)", async () => {
    expectEntryHintAfterHeadChunks(await fetchDocument(f.url("/")));
  });

  test("page hydrates cleanly under the module bootstrap", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/"));
    await waitForHydration(page);
  });

  test("no head chunk scripts", async () => {
    // plugin-rsc reports no JS deps per client reference in dev, so the
    // head chunk assertions live in the production describes. A dev
    // document that starts carrying head chunk scripts fails here first.
    expect(headChunkScripts(await fetchDocument(f.url("/")))).toEqual([]);
  });

  test("a client Link navigates after hydration", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/"));
    await waitForHydration(page);
    await expectClientLinkNavigation(page, "nav-about", "/about");
  });
});

test.describe("head-script-preinit (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });

  test("head has executing module scripts for client chunks, no leftover hints", async () => {
    const html = await fetchDocument(f.url("/"));

    expect(headChunkScripts(html).length).toBeGreaterThan(0);

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

  test("head chunk scripts carry no fetchpriority", async () => {
    // Lowering them was measured and rejected (#1021): on pages with images
    // above the fold the Low chunks queue behind the images and delay hydration.
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
    await expectClientLinkNavigation(page, "nav-about", "/about");
  });
});
