import { expect, test, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { guardHydrationErrors } from "./hydration-guard.js";

/**
 * A `ppr` page under a store layout whose client chrome reads the layout's
 * `loader(Def, { ssr: false })` outside any `<Suspense>`, declared directly
 * under the layout and mounted through `include()` under it (#1179: the
 * included page stayed on MISS). Fixture: ppr-include-bake* in each app.
 */

export interface PprIncludeBakeScenarioOptions {
  url: (pathname: string) => string;
  /** The ppr page declared directly under the layout. */
  directPath: string;
  /** The same page mounted through include() under the layout. */
  includedPath: string;
}

const HTML_HEADERS = { Accept: "text/html" };
const CHROME_RUN = /data-testid="ppr-include-chrome"[^>]*>(chrome run \d+)</;

async function getDocument(
  request: APIRequestContext,
  url: string,
): Promise<{ shell: string | undefined; chrome: string | undefined }> {
  const res = await request.get(url, { headers: HTML_HEADERS });
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain("PPR include page");
  return {
    shell: res.headers()["x-rango-shell"],
    chrome: html.match(CHROME_RUN)?.[1],
  };
}

export function runPprIncludeBakeTests(
  options: PprIncludeBakeScenarioOptions,
): void {
  const cases = [
    ["declared directly under the layout", options.directPath],
    ["mounted through include() under the layout", options.includedPath],
  ] as const;

  for (const [label, path] of cases) {
    test(`a ppr page ${label} goes MISS then HIT, and its HITs serve the chrome loader value the capture baked`, async ({
      page,
    }) => {
      const url = options.url(`${path}?probe=${randomUUID()}`);

      const miss = await getDocument(page.request, url);
      expect(miss.shell).toBe("MISS");
      expect(miss.chrome).toBeDefined();

      // The capture runs in the background of the MISS.
      await expect(async () => {
        expect((await getDocument(page.request, url)).shell).toBe("HIT");
      }).toPass({ timeout: 20_000 });

      // The loader is promise-free: a HIT serves its baked value and does
      // not run it, so every HIT shows the capture's run.
      const first = await getDocument(page.request, url);
      const second = await getDocument(page.request, url);
      expect(first.shell).toBe("HIT");
      expect(second.shell).toBe("HIT");
      expect(first.chrome).toBeDefined();
      expect(second.chrome).toBe(first.chrome);

      using _ = guardHydrationErrors(page);
      const response = await page.goto(url);
      expect(response?.headers()["x-rango-shell"]).toBe("HIT");
      await page.waitForFunction(
        () => document.documentElement.hasAttribute("data-hydrated"),
        undefined,
        { timeout: 20_000 },
      );
      await expect(page.getByTestId("ppr-include-chrome")).toHaveText(
        first.chrome!,
      );
      await expect(page.getByTestId("ppr-include-page")).toBeVisible();
    });
  }
}
