import { expect, test } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * React Compiler verification for the cloudflare-basic app — the Cloudflare
 * path, where @cloudflare/vite-plugin (not rango) supplies @vitejs/plugin-rsc.
 *
 * The compiler is wired exactly like the @vitejs/plugin-rsc example: a
 * top-level @rolldown/plugin-babel running reactCompilerPreset(), ordered after
 * react() and before rango()/cloudflare() (see cloudflare-basic/vite.config.ts).
 * This suite confirms the compiler transforms components in BOTH dev and
 * production even when the RSC plugin is contributed by the Cloudflare plugin.
 *
 * Marker: React Compiler reads each memo-cache slot back with a strict
 * comparison `$[i] === Symbol.for("react.memo_cache_sentinel")`. That triple-`=`
 * form is emitted only by compiled components (React core's lone sentinel
 * *definition* uses a single `=`), so the regex has a zero baseline without the
 * compiler and survives minification identically in the cloudflare build.
 */

// The test file lives in tests/cloudflare-basic/e2e; the build emits client
// assets to tests/cloudflare-basic/dist/client/assets (the Cloudflare plugin's
// client output). dist is produced by the playwright webServer's `pnpm build`.
const CLIENT_ASSETS_DIR = join(
  import.meta.dirname,
  "..",
  "dist",
  "client",
  "assets",
);

const COMPILED_MARKER = /===\s*Symbol\.for\(\s*["'`]react\.memo_cache_sentinel/;

function readClientBundle(): string {
  return readdirSync(CLIENT_ASSETS_DIR)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(CLIENT_ASSETS_DIR, f), "utf-8"))
    .join("\n");
}

async function incrementsByOne(
  page: import("@playwright/test").Page,
  url: string,
) {
  await page.goto(url);
  await waitForHydration(page);
  const before = parseInt(
    (await testId(page, "counter-value").textContent())?.match(/\d+/)?.[0] ??
      "0",
    10,
  );
  await testId(page, "counter-increment").click();
  await expect(testId(page, "counter-value")).toContainText(
    `Count: ${before + 1}`,
    { timeout: 10000 },
  );
}

// ---------------------------------------------------------------------------
// Dev mode (workerd). workerd runs the RSC/SSR side, but the client environment
// is still served by Vite, so the browser loads compiled client modules — which
// we capture off the wire to assert the compiler ran.
// ---------------------------------------------------------------------------

test.describe("react compiler (cloudflare-basic)", () => {
  test.describe.configure({ mode: "serial" });

  const f = useFixture({ root: ".", mode: "dev" });

  test("dev: browser loads compiled client modules", async ({ page }) => {
    using _ = expectNoPageError(page);
    const jsBodies: string[] = [];
    const pending: Promise<void>[] = [];
    page.on("response", (resp) => {
      const ct = resp.headers()["content-type"] ?? "";
      if (!ct.includes("javascript") && !/\.[tj]sx?(\?|$)/.test(resp.url())) {
        return;
      }
      pending.push(
        resp
          .text()
          .then((t) => {
            jsBodies.push(t);
          })
          .catch(() => {
            // body not retrievable (from cache / redirect) — ignore
          }),
      );
    });
    await page.goto(f.url("/counter"));
    await waitForHydration(page);
    await Promise.all(pending);
    // At least one loaded client module carries the universal compiler
    // signature — the react/compiler-runtime allocator import. (Asserted over
    // what the browser actually fetched, which sidesteps workerd dev's opaque
    // module URLs.)
    expect(jsBodies.some((b) => b.includes("compiler-runtime"))).toBe(true);
  });

  test("dev: compiled client component is interactive", async ({ page }) => {
    using _ = expectNoPageError(page);
    await incrementsByOne(page, f.url("/counter"));
  });
});

// ---------------------------------------------------------------------------
// Production mode — read the built client bundle off disk + drive the app.
// ---------------------------------------------------------------------------

test.describe("react compiler (cloudflare-basic) (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });

  test("production: client bundle contains compiled memo-cache output", () => {
    expect(readClientBundle()).toMatch(COMPILED_MARKER);
  });

  test("production: compiled client component is interactive", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await incrementsByOne(page, f.url("/counter"));
  });
});
