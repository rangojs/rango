import test, { expect } from "@playwright/test";
import {
  fetchDocument,
  fizzBootstrapScript,
  modulepreloadHrefs,
  scriptAndLinkTags,
} from "@shared/e2e";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Script-strategy e2e: client-reference chunks ship as EXECUTING
 * `<script type="module" async>` tags hoisted into <head> (preinitModule
 * upgrade of plugin-rsc's modulepreload hints), and the browser entry ships as
 * `bootstrapModules` — a head `<link rel="modulepreload" fetchpriority="low">`
 * hint paired with the executing `<script type="module" id="_R_" async>` at
 * end of shell. See src/ssr/preinit-client-references.ts.
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

  test("dev: page hydrates cleanly under the module bootstrap", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/"));
    await waitForHydration(page);
  });
});

test.describe("head-script-preinit (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });

  test("head has executing module scripts for client chunks, no leftover hints", async () => {
    const html = await fetchDocument(f.url("/"));
    const headEnd = html.indexOf("</head>");
    expect(headEnd).toBeGreaterThan(0);
    const head = html.slice(0, headEnd);

    // Client-reference chunks are executing async module scripts in <head>.
    const headModuleScripts = scriptAndLinkTags(head).filter(
      (t) =>
        t.startsWith("<script") &&
        t.includes('type="module"') &&
        t.includes('src="') &&
        t.includes("async"),
    );
    expect(headModuleScripts.length).toBeGreaterThan(0);

    // The preinit UPGRADE removed their modulepreload hints: the only
    // modulepreload left is the entry's, and it pairs with the executing
    // bootstrap at end of shell.
    const { tag, src } = fizzBootstrapScript(html);
    expect(modulepreloadHrefs(html)).toEqual([src]);
    expect(tag).toContain('type="module"');
  });

  test("page hydrates cleanly under the head-executing scripts", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/"));
    await waitForHydration(page);
  });
});
