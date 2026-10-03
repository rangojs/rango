import { test } from "@playwright/test";
import path from "node:path";
import {
  checkoutPortOffset,
  createDeployFixture,
  runCacheVersionScenario,
} from "@shared/e2e";

/**
 * Per-router cache versions, end to end on the Cloudflare preset (design:
 * docs/design/per-app-cache-version.md). The node twin is
 * packages/rangojs-router/e2e/cache-version.test.ts; both run the same
 * scenario (runCacheVersionScenario in @shared/e2e).
 *
 * The app is tests/cloudflare-basic/.cache-version-fixture: a host router with
 * two sub-apps on a CFCacheStore with KV. miniflare persists the Cache API and
 * KV under the working copy's .wrangler/, so entries outlive a server restart
 * the way they do on the edge. The suite builds a private copy four times
 * (baseline, unchanged rebuild, a server change to app A, a client change) and
 * restarts the server on each build.
 *
 * Production only, by nature: the versions are computed by `vite build` from
 * the built output and there is no dev counterpart to deploy. In dev both
 * versions are one stamp that changes on every RSC module edit, which the HMR
 * suite covers (hmr-*.test.ts). This describe owns no useFixture, so the
 * dev/production parity check does not expect a dev twin.
 */
const appDir = path.resolve(".");
// Clear of the shared 5198/5199 webServers and of the router suite's 5393.
const PORT = 5395 + checkoutPortOffset();

test.describe("cache versions across deploys (production)", () => {
  test.describe.configure({ timeout: 300_000 });

  const fixture = createDeployFixture({
    source: path.join(appDir, ".cache-version-fixture"),
    workDir: path.join(appDir, ".cache-version-work"),
    appDir,
    port: PORT,
    env: {
      // A stable key: without one every build gets its own, and a router that
      // encrypts with it would get a new version on every build.
      RANGO_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      // Each router's route manifest as a workerd Text module, the form a
      // large app deploys. The Cloudflare plugin imports it through a marker
      // specifier it replaces later; hashed as an unknown package, that gave
      // every build its own version (6 of 6 builds of the stress demo).
      RANGO_MANIFEST_TEXT: "1",
    },
    readyHeaders: { cookie: "x-rango-host=a.localhost" },
  });

  test.afterAll(async () => {
    await fixture.cleanup();
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
