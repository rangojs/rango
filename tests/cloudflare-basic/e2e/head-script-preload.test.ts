import test, { expect, type Page } from "@playwright/test";
import {
  fetchDocument,
  modulepreloadHrefs,
  scriptAndLinkTags,
} from "@shared/e2e";
import { blockPrefetch } from "@rangojs/router/testing/e2e";
import { useFixture } from "./fixture";
import { expectNoPageError, waitForHydration } from "./helper";

function assertPreloadDocument(
  html: string,
  requireClientReferenceHint: boolean,
): void {
  const headEnd = html.indexOf("</head>");
  expect(headEnd).toBeGreaterThan(0);
  const head = html.slice(0, headEnd);
  const externalModuleScripts = scriptAndLinkTags(head).filter(
    (tag) =>
      tag.startsWith("<script") &&
      tag.includes('type="module"') &&
      tag.includes('src="'),
  );
  expect(externalModuleScripts).toEqual([]);

  const bootstrap = html.match(
    /<script\b(?=[^>]*\bid="_R_")[^>]*>([\s\S]*?)<\/script>/,
  );
  expect(
    bootstrap,
    "the inline fizz bootstrap script is present",
  ).not.toBeNull();
  const tagEnd = bootstrap![0].indexOf(">");
  const tag = bootstrap![0].slice(0, tagEnd + 1);
  expect(tag).not.toContain('src="');
  const entryImport = bootstrap![1]!.match(
    /\bimport\(\s*(["'])([^"']+)\1\s*\)/,
  );
  expect(
    entryImport,
    "the inline bootstrap imports the browser entry",
  ).not.toBeNull();

  if (requireClientReferenceHint) {
    const browserEntryUrl = entryImport![2]!;
    const clientReferenceHrefs = modulepreloadHrefs(html).filter(
      (href) => href !== browserEntryUrl,
    );
    expect(clientReferenceHrefs.length).toBeGreaterThan(0);
  }
}

async function expectCleanHydration(page: Page, url: string): Promise<void> {
  using _ = expectNoPageError(page);
  await blockPrefetch(page);
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto(url);
  await waitForHydration(page);
  expect(consoleErrors).toEqual([]);
}

test.describe("head-script-preload", () => {
  const f = useFixture({ root: ".", mode: "dev" });

  test("uses an inline bootstrap without executing external head scripts", async () => {
    assertPreloadDocument(await fetchDocument(f.url("/")), false);
  });

  test("hydrates without browser errors", async ({ page }) => {
    await expectCleanHydration(page, f.url("/"));
  });
});

test.describe("head-script-preload (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });

  test("keeps client-reference hints with an inline bootstrap", async () => {
    assertPreloadDocument(await fetchDocument(f.url("/")), true);
  });

  test("hydrates without browser errors", async ({ page }) => {
    await expectCleanHydration(page, f.url("/"));
  });
});
