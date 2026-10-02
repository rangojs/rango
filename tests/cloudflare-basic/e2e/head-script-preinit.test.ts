import test, { expect } from "@playwright/test";
import {
  expectClientLinkNavigation,
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
 * head modulepreload hint paired with the executing
 * `<script type="module" id="_R_" async>` at end of shell.
 * Mirrors packages/rangojs-router/e2e/head-script-preinit.test.ts; the workerd
 * copy pins that the preinit path (node:async_hooks import included) loads and
 * renders in the workerd SSR environment. The nonce VALUE assertion lives in
 * tests/react-experimental/e2e/gtm.test.ts (the only CSP-wired fixture, node
 * preset) — workerd has no nonce'd fixture, a known coverage gap. The
 * opt-in `fetchPriority: "low"` build is covered by
 * head-script-priority-low.test.ts.
 */

test.describe("head-script-preinit (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });

  test("entry ships as a module script with a matching modulepreload hint", async () => {
    const html = await fetchDocument(f.url("/"));
    const { tag, src } = fizzBootstrapScript(html);

    expect(tag).toContain('type="module"');
    expect(modulepreloadHrefs(html)).toContain(src);
  });

  test("page hydrates cleanly under the module bootstrap", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/"));
    await waitForHydration(page);
  });

  test("no head chunk scripts to prioritize", async () => {
    // plugin-rsc reports no JS deps per client reference in dev, so the
    // fetchpriority assertions live in the production describes. A dev
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
    await expectClientLinkNavigation(page, "nav-about", "/about");
  });
});
