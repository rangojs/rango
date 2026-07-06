import { defineConfig, devices } from "@playwright/test";
import { checkoutPortOffset } from "@shared/e2e";

const browserConfig = {
  ...devices["Desktop Chrome"],
  viewport: null,
  deviceScaleFactor: undefined,
};

const webkitConfig = {
  ...devices["Desktop Safari"],
};

// Per-checkout port isolation, automatic: the offset hashes this checkout's
// path, so parallel clones get disjoint port blocks with zero setup while the
// same clone keeps stable ports across runs (reuseExistingServer still reuses
// your own servers). RANGO_E2E_PORT_OFFSET overrides; CI pins 0. See
// checkoutPortOffset in tests/shared-e2e for the full why.
const PORT_OFFSET = checkoutPortOffset();

const DEV_SERVER_PORT = 5188 + PORT_OFFSET;
const PREVIEW_SERVER_PORT = 5189 + PORT_OFFSET;
// Host-router fixture servers (e2e/test-app/.host-fixture) for host-routing.test.ts.
// Repo-unique ports: 5198/5199 collide with tests/cloudflare-basic (dev 5199 /
// preview 5198), which under `reuseExistingServer` would silently run the host
// tests against the cloudflare-basic app. host-routing.test.ts derives the same
// bases + checkoutPortOffset(), so it cannot drift from this config.
const HOST_DEV_PORT = 5296 + PORT_OFFSET;
const HOST_PREVIEW_PORT = 5297 + PORT_OFFSET;

const isUIMode = process.argv.includes("--ui");
const isCI = !!process.env.CI;

// Host-fixture isolation (finding: host servers must not boot on every shard).
// The host-routing suite lives in its own `host` project + a dedicated CI job
// that sets RANGO_E2E_HOST=1. On the sharded dev/production CI jobs the flag is
// unset, so the two extra host Vite servers (and the host:build) never start --
// keeping those OOM-sensitive shards lean and decoupling them from host-fixture
// health. Locally the whole suite runs in one process, so the host project +
// servers are included there too.
const RUN_HOST = !isCI || process.env.RANGO_E2E_HOST === "1";
// The dedicated host CI job runs ONLY `--project=host`, so it skips the heavy
// test-app build/dev/preview servers.
const HOST_ONLY = process.env.RANGO_E2E_HOST === "1";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  globalTimeout: 600000, // 10 minutes max
  timeout: process.env.CI ? 60000 : 30000, // 60s on CI, 30s locally
  webServer: [
    ...(HOST_ONLY
      ? []
      : [
          {
            // Build first (for production tests), then clean optimizer cache and
            // start dev server. Building before the dev server prevents `vite
            // build` from overwriting the running server's optimizer cache
            // (node_modules/.vite/deps).
            command: `pnpm build && rm -rf node_modules/.vite-e2e-test-app && pnpm dev --port ${DEV_SERVER_PORT}`,
            cwd: "./e2e/test-app",
            port: DEV_SERVER_PORT,
            reuseExistingServer: !process.env.CI,
          },
          {
            // Shared preview server for all production tests using test-app.
            // Started after the build (included in the dev server command above).
            command: `pnpm preview --port ${PREVIEW_SERVER_PORT}`,
            cwd: "./e2e/test-app",
            port: PREVIEW_SERVER_PORT,
            reuseExistingServer: !process.env.CI,
          },
        ]),
    ...(RUN_HOST
      ? [
          {
            // Host-router fixture (e2e/test-app/.host-fixture), node preset. Dev
            // server for host-routing.test.ts "(dev)". Self-contained (vite dev
            // generates its own manifests).
            command: `pnpm host:dev --port ${HOST_DEV_PORT}`,
            cwd: "./e2e/test-app",
            port: HOST_DEV_PORT,
            reuseExistingServer: !process.env.CI,
          },
          {
            // Host-router fixture preview (built) for host-routing.test.ts
            // "(production)". Builds then serves the .vercel/output-equivalent
            // node build.
            command: `pnpm host:build && pnpm host:preview --port ${HOST_PREVIEW_PORT}`,
            cwd: "./e2e/test-app",
            port: HOST_PREVIEW_PORT,
            reuseExistingServer: !process.env.CI,
          },
        ]
      : []),
  ],
  use: {
    screenshot: "only-on-failure",
    trace: "on-all-retries",
  },
  expect: {
    timeout: 10000,
    toPass: { timeout: 10000 },
  },
  // In UI mode, flatten projects to avoid the dependency chain that breaks
  // Playwright's --ui filtering (--grep, --project, file args).
  // See: https://github.com/microsoft/playwright/issues/21952
  projects: isUIMode
    ? [
        {
          name: "smoke",
          testMatch: "**/smoke.test.ts",
          use: browserConfig,
        },
        {
          name: "dev",
          // Exclude any production-tagged describe blocks, including
          // variants like "(production build)".
          grep: /^(?!.*\(production)/,
          testIgnore: [
            "**/smoke.test.ts",
            "**/loader-hmr.test.ts",
            "**/route-types-hmr.test.ts",
            "**/client-component-hmr.test.ts",
            "**/intercept-hmr*.test.ts",
            "**/prerender-hmr.test.ts",
            "**/basename-hmr.test.ts",
            "**/refresh-cmd.test.ts",
            "**/*.setup.ts",
            // mini is a Vitest dogfood app nested under e2e/; its vitest
            // test/*.test.tsx files must not be collected by Playwright.
            "**/mini/**",
          ],
          use: {
            ...browserConfig,
            baseURL: `http://localhost:${DEV_SERVER_PORT}`,
          },
        },
        {
          name: "production",
          grep: /\(production/,
          testIgnore: ["**/smoke.test.ts", "**/mini/**"],
          use: {
            ...browserConfig,
            baseURL: `http://localhost:${PREVIEW_SERVER_PORT}`,
          },
          fullyParallel: false,
        },
        {
          name: "hmr-prerender",
          testMatch: "**/prerender-hmr.test.ts",
          use: browserConfig,
          fullyParallel: false,
          dependencies: ["dev"],
        },
        {
          name: "hmr-client",
          testMatch: "**/client-component-hmr.test.ts",
          use: browserConfig,
          fullyParallel: false,
          dependencies: ["dev"],
        },
        {
          name: "hmr-loader",
          testMatch: ["**/loader-hmr.test.ts", "**/refresh-cmd.test.ts"],
          use: browserConfig,
          fullyParallel: false,
          dependencies: ["dev"],
        },
        {
          name: "hmr-routes",
          testMatch: "**/route-types-hmr.test.ts",
          use: browserConfig,
          fullyParallel: false,
          dependencies: ["dev"],
        },
        {
          name: "hmr-intercept",
          testMatch: "**/intercept-hmr*.test.ts",
          use: browserConfig,
          fullyParallel: false,
          dependencies: ["dev"],
        },
        {
          name: "hmr-basename",
          testMatch: "**/basename-hmr.test.ts",
          use: browserConfig,
          fullyParallel: false,
          // Basename HMR modifies router.tsx to add basename: "/app",
          // which triggers route rediscovery and rewrites the gen file.
          // Must run after dev tests to avoid contaminating parallel tests.
          dependencies: ["dev"],
        },
        {
          name: "webkit-smoke",
          testMatch: "**/smoke.test.ts",
          use: webkitConfig,
        },
      ]
    : [
        {
          name: "smoke",
          testMatch: "**/smoke.test.ts",
          use: browserConfig,
        },
        {
          name: "build",
          testMatch: "**/build-test-app.setup.ts",
          dependencies: ["smoke"],
        },
        {
          name: "dev-warmup",
          testMatch: "**/dev-warmup.setup.ts",
          use: {
            ...browserConfig,
            baseURL: `http://localhost:${DEV_SERVER_PORT}`,
          },
          dependencies: ["build"],
        },
        // Host-routing suite: its own project + warmup, included only when the
        // host servers are up (RUN_HOST). On the sharded dev/production CI jobs
        // (RUN_HOST false) these are absent and host-routing is excluded from the
        // dev/production projects below, so no host server needs to boot there.
        ...(RUN_HOST
          ? [
              {
                // Primes the host-router dev server's dep optimizer before the
                // host-routing "(dev)" tests, so their client boot is fast/quiet.
                name: "host-dev-warmup",
                testMatch: "**/host-warmup.setup.ts",
                use: {
                  ...browserConfig,
                  baseURL: `http://localhost:${HOST_DEV_PORT}`,
                },
              },
              {
                // host-routing.test.ts drives both the "(dev)" and "(production)"
                // host describes against absolute-URL host servers (5296/5297), so
                // it needs no baseURL. Serial: it clears cookies between visits.
                name: "host",
                testMatch: "**/host-routing.test.ts",
                use: browserConfig,
                fullyParallel: false,
                dependencies: ["host-dev-warmup"],
              },
            ]
          : []),
        {
          name: "dev",
          // Exclude production tests (by test name) and HMR test files (by file name)
          grep: /^(?!.*\(production)/,
          testIgnore: [
            "**/smoke.test.ts",
            "**/loader-hmr.test.ts",
            "**/route-types-hmr.test.ts",
            "**/client-component-hmr.test.ts",
            "**/intercept-hmr*.test.ts",
            "**/prerender-hmr.test.ts",
            "**/basename-hmr.test.ts",
            "**/refresh-cmd.test.ts",
            "**/*.setup.ts",
            // host-routing runs in its own `host` project (with its own servers),
            // not the sharded dev bucket -- see the RUN_HOST block above.
            "**/host-routing.test.ts",
            // mini is a Vitest dogfood app nested under e2e/; its vitest
            // test/*.test.tsx files must not be collected by Playwright.
            "**/mini/**",
          ],
          use: {
            ...browserConfig,
            baseURL: `http://localhost:${DEV_SERVER_PORT}`,
          },
          dependencies: ["dev-warmup"],
        },
        {
          name: "production",
          grep: /\(production/,
          testIgnore: [
            "**/smoke.test.ts",
            // host-routing "(production)" runs in the `host` project.
            "**/host-routing.test.ts",
            "**/mini/**",
          ],
          use: {
            ...browserConfig,
            baseURL: `http://localhost:${PREVIEW_SERVER_PORT}`,
          },
          // Shared preview server on the built test-app has shown intermittent
          // connection-refused failures under long high-parallel runs. Keep the
          // production project serial for stability.
          fullyParallel: false,
          dependencies: ["build"],
        },
        {
          name: "hmr-client",
          testMatch: "**/client-component-hmr.test.ts",
          use: browserConfig,
          fullyParallel: false,
          // HMR tests modify route files in the shared test-app directory.
          // The dev server's Vite watcher picks up these changes, invalidating
          // modules and busting the in-memory cache — causing cache tests to fail.
          // Must run after dev tests complete.
          dependencies: ["dev"],
        },
        {
          name: "hmr-loader",
          testMatch: ["**/loader-hmr.test.ts", "**/refresh-cmd.test.ts"],
          use: browserConfig,
          fullyParallel: false,
          dependencies: ["dev", "hmr-client"],
        },
        {
          name: "hmr-routes",
          // Route-types HMR modifies route definition files — must not
          // overlap with intercept-hmr which expects routes to be intact.
          testMatch: "**/route-types-hmr.test.ts",
          use: browserConfig,
          fullyParallel: false,
          dependencies: ["dev", "hmr-loader"],
        },
        {
          name: "hmr-intercept",
          // Intercept HMR modifies the intercept config file. Runs after
          // route-types HMR to avoid file-modification conflicts.
          testMatch: "**/intercept-hmr*.test.ts",
          use: browserConfig,
          fullyParallel: false,
          dependencies: ["dev", "hmr-routes"],
        },
        {
          name: "hmr-basename",
          // Basename HMR modifies router.tsx to add basename: "/app",
          // which triggers route rediscovery and rewrites the gen file
          // with /app-prefixed routes. Must run after dev tests to avoid
          // contaminating parallel tests with the wrong route map.
          testMatch: "**/basename-hmr.test.ts",
          use: browserConfig,
          fullyParallel: false,
          dependencies: ["dev"],
        },
        {
          name: "hmr-prerender",
          // Local-only: tests skip on CI via test.skip(!!process.env.CI).
          testMatch: "**/prerender-hmr.test.ts",
          use: browserConfig,
          fullyParallel: false,
          dependencies: ["dev"],
        },
        {
          name: "webkit-smoke",
          testMatch: "**/smoke.test.ts",
          use: webkitConfig,
          // Run after the build completes to avoid resource contention.
          // Does not depend on dev/production to avoid being blocked by
          // flaky dev tests.
          dependencies: ["build"],
        },
      ],
  workers: 3,
  forbidOnly: !!process.env.CI,
  retries: 2,
  reporter: [
    ["list"],
    ...(process.env.CI ? [["github"], ["html", { open: "never" }]] : []),
  ] as import("@playwright/test").ReporterDescription[],
});
