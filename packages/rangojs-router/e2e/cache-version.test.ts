import { test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkoutPortOffset,
  createDeployFixture,
  runCacheVersionScenario,
} from "@shared/e2e";

/**
 * Per-router cache versions, end to end on the node preset (design:
 * docs/design/per-app-cache-version.md). The Cloudflare twin is
 * tests/cloudflare-basic/e2e/cache-version.test.ts; both run the same
 * scenario (runCacheVersionScenario in @shared/e2e).
 *
 * The app is e2e/test-app/.cache-version-fixture: a host router with two
 * sub-apps whose `cache()` entries go to a VercelCacheStore over a
 * directory-backed cache handle, so they outlive a server restart the way a
 * deployed store's do. The suite builds a private copy four times (baseline,
 * unchanged rebuild, a server change to app A, a client change) and restarts
 * the server on each build.
 *
 * Production only, by nature: the versions are computed by `vite build` from
 * the built output and there is no dev counterpart to deploy. In dev both
 * versions are one stamp that changes on every RSC module edit, which the HMR
 * suites cover (route-types-hmr, client-component-hmr: "version changed"); the
 * dev module's shape is pinned by src/vite/__tests__/version-plugin.test.ts.
 * This describe owns no useFixture, so the dev/production parity check does
 * not expect a dev twin.
 */
const appDir = path.resolve("./e2e/test-app");
// Next to the 5391 of transition-when-invalid.test.ts; no shared webServer
// uses it.
const PORT = 5393 + checkoutPortOffset();

test.describe("cache versions across deploys (production)", () => {
  test.describe.configure({ timeout: 240_000 });

  const cacheDir = mkdtempSync(path.join(tmpdir(), "rango-cache-version-"));
  const fixture = createDeployFixture({
    source: path.join(appDir, ".cache-version-fixture"),
    workDir: path.join(appDir, ".cache-version-work"),
    appDir,
    port: PORT,
    env: {
      // A stable key: without one every build gets its own, and a router that
      // encrypts with it would get a new version on every build.
      RANGO_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      RANGO_E2E_CACHE_DIR: cacheDir,
    },
    readyHeaders: { cookie: "x-rango-host=a.localhost" },
  });

  test.afterAll(async () => {
    await fixture.cleanup();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  test("a deploy keeps or clears each app's cache, and reloads its tabs, by what changed", async ({
    browser,
  }) => {
    await runCacheVersionScenario({
      fixture,
      browser,
      hostCookie: "x-rango-host",
      routerSource: {
        a: "src/apps/a/router.tsx",
        b: "src/apps/b/router.tsx",
      },
      serverEdit: {
        file: "src/apps/a/urls.tsx",
        change: (source) => source.replace("App A v1", "App A v2"),
      },
      clientEdit: {
        file: "src/nav.tsx",
        change: (source) => source.replace("nav v1", "nav v2"),
      },
    });
  });
});
