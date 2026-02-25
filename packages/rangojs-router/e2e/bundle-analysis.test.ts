import { expect, test } from "@playwright/test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { x } from "tinyexec";

/**
 * Tests for build output correctness:
 * 1. Loader implementations should NOT be in client bundle
 * 2. Server action implementations should NOT be in client bundle
 * 3. Only references/stubs should exist in client bundle
 *
 * These are static analysis tests that verify tree-shaking works correctly.
 *
 * Run with TEST_SKIP_BUILD=1 to skip the build step (for CI where build is done separately).
 */

const TEST_APP_ROOT = join(import.meta.dirname, "test-app");
const CLIENT_ASSETS_DIR = join(TEST_APP_ROOT, "dist/client/assets");
const RSC_ASSETS_DIR = join(TEST_APP_ROOT, "dist/rsc/assets");
const RSC_INDEX = join(TEST_APP_ROOT, "dist/rsc/index.js");
const SSR_DIR = join(TEST_APP_ROOT, "dist/ssr");
const SSR_ASSETS_DIR = join(SSR_DIR, "assets");
const SSR_INDEX = join(SSR_DIR, "index.js");

test.describe("bundle-analysis", () => {
  test.beforeAll(async () => {
    // Build if dist doesn't exist and TEST_SKIP_BUILD is not set
    if (!existsSync(CLIENT_ASSETS_DIR) && !process.env.TEST_SKIP_BUILD) {
      console.log("Building test app for bundle analysis...");
      const result = await x("pnpm", ["build"], {
        nodeOptions: { cwd: TEST_APP_ROOT },
      });
      if (result.exitCode !== 0) {
        throw new Error(`Build failed: ${result.stderr}`);
      }
    }

    // Verify build output exists
    if (!existsSync(CLIENT_ASSETS_DIR)) {
      throw new Error(
        `Client assets not found. Run 'pnpm build' in ${TEST_APP_ROOT} first.`,
      );
    }
  });

  function getClientBundleContent(): string {
    const files = readdirSync(CLIENT_ASSETS_DIR).filter((f) =>
      f.endsWith(".js"),
    );
    return files
      .map((file) => readFileSync(join(CLIENT_ASSETS_DIR, file), "utf-8"))
      .join("\n");
  }

  function getRscBundleContent(): string {
    // Include main index.js and all asset files
    const assetFiles = readdirSync(RSC_ASSETS_DIR).filter((f) =>
      f.endsWith(".js"),
    );
    const assetContent = assetFiles
      .map((file) => readFileSync(join(RSC_ASSETS_DIR, file), "utf-8"))
      .join("\n");

    // Also include the main RSC index.js where most code is bundled
    const indexContent = existsSync(RSC_INDEX)
      ? readFileSync(RSC_INDEX, "utf-8")
      : "";

    return indexContent + "\n" + assetContent;
  }

  function getSsrBundleContent(): string {
    const assetFiles = existsSync(SSR_ASSETS_DIR)
      ? readdirSync(SSR_ASSETS_DIR).filter((f) => f.endsWith(".js"))
      : [];
    const assetContent = assetFiles
      .map((file) => readFileSync(join(SSR_ASSETS_DIR, file), "utf-8"))
      .join("\n");

    const indexContent = existsSync(SSR_INDEX)
      ? readFileSync(SSR_INDEX, "utf-8")
      : "";

    return indexContent + "\n" + assetContent;
  }

  test.describe("loader-tree-shaking", () => {
    test("loader implementations should NOT be in client bundle", async () => {
      const clientBundle = getClientBundleContent();

      // Product data from loaders.ts should not be in client
      expect(clientBundle).not.toContain("Product A");
      expect(clientBundle).not.toContain("99.99");
      expect(clientBundle).not.toContain("First test product");

      // Loader implementation details should not be in client
      expect(clientBundle).not.toContain("slowLoaderCount");
      expect(clientBundle).not.toContain("Product not found:");
    });

    test("loader implementations SHOULD be in RSC bundle", async () => {
      const rscBundle = getRscBundleContent();

      // Product data should be in RSC bundle
      expect(rscBundle).toContain("Product A");
      expect(rscBundle).toContain("99.99");

      // Loader export names should be in RSC bundle ($$id uses export name with hash prefix)
      expect(rscBundle).toContain("ProductsLoader");
      expect(rscBundle).toContain("ProductDetailLoader");
      expect(rscBundle).toContain("CartQuantityLoader");
      expect(rscBundle).toContain("SlowLoader");
    });

    test("client bundle should only have loader name references", async () => {
      const clientBundle = getClientBundleContent();

      // LoaderBoundary component code should exist (it's a client component).
      // The name itself may be minified, so check for a unique string literal
      // from route-content-wrapper.tsx that survives minification.
      expect(clientBundle).toContain("route-content-suspense-");

      // But the actual loader function implementations should not
      expect(clientBundle).not.toMatch(/createLoader\s*\(\s*["']products["']/);
    });
  });

  test.describe("action-tree-shaking", () => {
    test("server action implementations should NOT be in client bundle", async () => {
      const clientBundle = getClientBundleContent();

      // In-memory cart state should not be in client
      expect(clientBundle).not.toContain("cartItems");
      expect(clientBundle).not.toMatch(/let\s+cart/);

      // Action implementation details should not be in client
      expect(clientBundle).not.toContain("to cart");
    });

    test("server action implementations SHOULD be in RSC bundle", async () => {
      const rscBundle = getRscBundleContent();

      // Cart state should be in RSC bundle (keyed by cart ID)
      expect(rscBundle).toContain("getCartId");

      // Action implementations should be in RSC bundle
      expect(rscBundle).toContain("addToCart");
      expect(rscBundle).toContain("updateQuantity");
      expect(rscBundle).toContain("getCartQuantity");
    });

    test("client bundle should only have action ID references", async () => {
      const clientBundle = getClientBundleContent();

      // Action references should exist as $$id markers
      expect(clientBundle).toMatch(/\$\$id.*addToCartWithResult/);
      expect(clientBundle).toMatch(/\$\$id.*updateQuantity/);
      expect(clientBundle).toMatch(/\$\$id.*triggerRevalidation/);
    });
  });

  test.describe("client-components", () => {
    test("client components should be in client bundle", async () => {
      const clientBundle = getClientBundleContent();

      // Client component implementations should be present
      expect(clientBundle).toContain("useActionState");
      expect(clientBundle).toContain("useOptimistic");

      // UI elements from client components should be present
      expect(clientBundle).toContain("Add to Cart");
      expect(clientBundle).toContain("Trigger Revalidation");
    });
  });

  test.describe("handle-tree-shaking", () => {
    test("handle collect function implementations should NOT be in client bundle", async () => {
      const clientBundle = getClientBundleContent();

      // The client has the Breadcrumbs handle object with $$id, but should NOT
      // contain the collect function body. createHandle() on the client side
      // receives no collect argument - it's only on the RSC side.
      expect(clientBundle).not.toMatch(
        /createHandle\s*\(\s*function|\bcreateHandle\s*\(\s*\(/,
      );

      // The BreadcrumbItem type and accumulation logic lives in handles.ts
      // on the server - the client should not contain those implementation details
      expect(clientBundle).not.toContain("BreadcrumbItem");
    });

    test("handle $$id references SHOULD exist in client bundle", async () => {
      const clientBundle = getClientBundleContent();

      // Breadcrumbs handle $$id must be present for useHandle to resolve data
      expect(clientBundle).toMatch(/\$\$id.*Breadcrumbs/);
    });

    test("handle $$id format should be hash#ExportName", async () => {
      const clientBundle = getClientBundleContent();

      // Extract the Breadcrumbs $$id value
      const match = clientBundle.match(
        /\$\$id\s*=\s*"([^"]+Breadcrumbs[^"]*)"/,
      );
      expect(match).toBeTruthy();

      const id = match![1];
      // Should be hex hash followed by #ExportName
      expect(id).toMatch(/^[0-9a-f]+#[A-Za-z]\w*$/);
      // Should NOT contain file paths
      expect(id).not.toContain("/");
      expect(id).not.toContain("src");
    });
  });

  test.describe("loader-id-format", () => {
    test("loader $$id in RSC bundle uses hash#Name format, not file paths", async () => {
      const rscBundle = getRscBundleContent();

      // Extract all loader $$id assignments
      const loaderIds = [
        ...rscBundle.matchAll(/\$\$id\s*=\s*"([^"]*Loader[^"]*)"/g),
      ].map((m) => m[1]);

      expect(loaderIds.length).toBeGreaterThan(0);

      for (const id of loaderIds) {
        // Each ID must be hash#ExportName
        expect(id).toMatch(/^[0-9a-f]+#[A-Za-z]\w*$/);
        // No file paths leaked
        expect(id).not.toContain("/");
        expect(id).not.toContain("src");
      }
    });

    test("all $$id patterns in RSC bundle are valid hash#Name format", async () => {
      const rscBundle = getRscBundleContent();

      // Collect all $$id = "..." assignments (actions, loaders, handles)
      const allIds = [...rscBundle.matchAll(/\$\$id\s*=\s*"([^"]+)"/g)].map(
        (m) => m[1],
      );

      expect(allIds.length).toBeGreaterThan(0);

      for (const id of allIds) {
        expect(id).toMatch(/^[0-9a-f]+#[A-Za-z]\w*$/);
      }
    });
  });

  test.describe("ssr-bundle-isolation", () => {
    test("SSR bundle should NOT contain product data or cart state", async () => {
      const ssrBundle = getSsrBundleContent();

      // Product data from loaders.ts is RSC-only
      expect(ssrBundle).not.toContain("Product A");
      expect(ssrBundle).not.toContain("99.99");
      expect(ssrBundle).not.toContain("First test product");

      // Cart state is RSC-only (server actions)
      expect(ssrBundle).not.toContain("cartItems");
    });

    test("SSR bundle should NOT contain loader function implementations", async () => {
      const ssrBundle = getSsrBundleContent();

      // Loader implementation details should not leak to SSR
      expect(ssrBundle).not.toContain("slowLoaderCount");
      expect(ssrBundle).not.toContain("Product not found:");
    });

    test("SSR bundle SHOULD contain client component code", async () => {
      const ssrBundle = getSsrBundleContent();

      // Client components are needed in SSR for hydration
      expect(ssrBundle).toContain("useHandle");
      expect(ssrBundle).toContain("LoaderBoundary");
    });
  });

  test.describe("server-internals-not-in-client", () => {
    test("no AsyncLocalStorage in client bundle", async () => {
      const clientBundle = getClientBundleContent();

      // AsyncLocalStorage is a Node.js server-only API
      expect(clientBundle).not.toContain("AsyncLocalStorage");
    });

    test("no route handler bodies in client bundle", async () => {
      const clientBundle = getClientBundleContent();

      // Route handlers use ctx.use(), ctx.params, ctx.env - none should be in client
      expect(clientBundle).not.toContain("ctx.use(");
      expect(clientBundle).not.toContain("ctx.params");
      expect(clientBundle).not.toContain("ctx.env");
    });
  });

  test.describe("comprehensive-id-inventory", () => {
    test("every $$id in client bundle is hash#Name format", async () => {
      const clientBundle = getClientBundleContent();

      // Collect all $$id="..." assignments in the client bundle
      const allClientIds = [
        ...clientBundle.matchAll(/\$\$id\s*=\s*"([^"]+)"/g),
      ].map((m) => m[1]);

      expect(allClientIds.length).toBeGreaterThan(0);

      for (const id of allClientIds) {
        // Must be hex hash + # + PascalCase export name
        expect(id).toMatch(/^[0-9a-f]+#[A-Za-z]\w*$/);
        // No file system paths
        expect(id).not.toContain("/");
        expect(id).not.toContain("src");
        expect(id).not.toContain(".ts");
        expect(id).not.toContain(".js");
      }
    });
  });

  test.describe("version-virtual-module", () => {
    test("VERSION should be in RSC bundle as hex string", async () => {
      // VERSION may be in index.js or an RSC asset chunk (e.g. __prerender-handlers)
      const rscBundle = getRscBundleContent();

      // VERSION should be defined as const VERSION = "hexstring"
      expect(rscBundle).toMatch(/const VERSION\s*=\s*["'][0-9a-f]+["']/i);
    });

    test("VERSION should be a valid hex timestamp", async () => {
      const rscBundle = getRscBundleContent();

      // Extract VERSION value from const declaration
      const versionMatch = rscBundle.match(
        /const VERSION\s*=\s*["']([0-9a-f]+)["']/i,
      );
      expect(versionMatch).toBeTruthy();

      const version = versionMatch![1];

      // Should be a valid hex number
      expect(/^[0-9a-f]+$/i.test(version)).toBe(true);

      // Should be reasonable length (11-12 chars for current timestamps)
      expect(version.length).toBeGreaterThanOrEqual(10);
      expect(version.length).toBeLessThanOrEqual(13);

      // Should convert to a reasonable timestamp (after 2020, before 2100)
      const timestamp = parseInt(version, 16);
      const minTimestamp = new Date("2020-01-01").getTime();
      const maxTimestamp = new Date("2100-01-01").getTime();
      expect(timestamp).toBeGreaterThan(minTimestamp);
      expect(timestamp).toBeLessThan(maxTimestamp);
    });

    test("VERSION should NOT be in client bundle", async () => {
      const clientBundle = getClientBundleContent();
      const rscBundle = getRscBundleContent();

      // Extract the actual VERSION from RSC bundle
      const versionMatch = rscBundle.match(
        /const VERSION\s*=\s*["']([0-9a-f]+)["']/i,
      );
      expect(versionMatch).toBeTruthy();

      const version = versionMatch![1];

      // The specific version string should not appear in client bundle
      expect(clientBundle).not.toContain(version);
    });
  });

  test.describe("prerender-handler-eviction", () => {
    function getPrerenderHandlersContent(): string | null {
      const files = readdirSync(RSC_ASSETS_DIR).filter(
        (f) => f.startsWith("__prerender-handlers") && f.endsWith(".js"),
      );
      if (files.length === 0) return null;
      return files
        .map((file) => readFileSync(join(RSC_ASSETS_DIR, file), "utf-8"))
        .join("\n");
    }

    function getRscIndexContent(): string {
      return existsSync(RSC_INDEX) ? readFileSync(RSC_INDEX, "utf-8") : "";
    }

    test("__prerender-handlers chunk exists in RSC bundle", async () => {
      const content = getPrerenderHandlersContent();
      expect(content).not.toBeNull();
      expect(content!.length).toBeGreaterThan(0);
    });

    test("handler implementation strings evicted from prerender-handlers chunk", async () => {
      const content = getPrerenderHandlersContent();
      expect(content).not.toBeNull();

      // Non-passthrough handler body strings should be replaced with stubs
      expect(content).not.toContain("pre-rendered documentation");
      expect(content).not.toContain("Content for");
    });

    test("handler implementation strings NOT in client bundle", async () => {
      const clientBundle = getClientBundleContent();

      expect(clientBundle).not.toContain("pre-rendered documentation");
    });

    test("handler implementation strings NOT in SSR bundle", async () => {
      const ssrBundle = getSsrBundleContent();

      expect(ssrBundle).not.toContain("pre-rendered documentation");
    });

    test("evicted handlers have stub shape", async () => {
      const content = getPrerenderHandlersContent();
      expect(content).not.toBeNull();

      // Evicted handlers are replaced with: { __brand: "prerenderHandler", $$id: "..." }
      expect(content).toMatch(/__brand.*prerenderHandler/);
    });

    test("__PRERENDER_MANIFEST imported into RSC entry", async () => {
      const rscIndex = getRscIndexContent();

      expect(rscIndex).toContain("__prerender-manifest.js");
      expect(rscIndex).toContain("__PRERENDER_MANIFEST");
    });

    test("__prerender-manifest.js has correct shape", async () => {
      const manifestPath = join(
        TEST_APP_ROOT,
        "dist/rsc/__prerender-manifest.js",
      );
      expect(existsSync(manifestPath)).toBe(true);

      const manifestCode = readFileSync(manifestPath, "utf-8");

      // Should contain docs routes (static route uses "_" param hash)
      expect(manifestCode).toContain('"docs/_"');

      // Should contain docs.article routes (dynamic with param hash)
      expect(manifestCode).toMatch(/"docs\.article\/[a-f0-9]+"/);

      // Should contain dynamic import references to __pr-*.js asset files
      expect(manifestCode).toMatch(
        /import\("\.\/assets\/__pr-[a-f0-9]+\.js"\)/,
      );
    });

    test("__pr-*.js asset files have correct shape", async () => {
      const prFiles = readdirSync(RSC_ASSETS_DIR).filter(
        (f) => f.startsWith("__pr-") && f.endsWith(".js"),
      );
      expect(prFiles.length).toBeGreaterThan(0);

      for (const file of prFiles) {
        const content = readFileSync(join(RSC_ASSETS_DIR, file), "utf-8");
        // Each asset exports a default with segments[] and handles{}
        expect(content).toContain("export default");
        const match = content.match(/export default\s+({[\s\S]*});\s*$/);
        expect(match).toBeTruthy();
        const data = JSON.parse(match![1]);
        expect(Array.isArray(data.segments)).toBe(true);
        expect(data.segments.length).toBeGreaterThan(0);
        expect(typeof data.handles).toBe("object");
      }
    });

    test("node:fs should NOT be in client bundle", async () => {
      const clientBundle = getClientBundleContent();

      expect(clientBundle).not.toContain("readFileSync");
      expect(clientBundle).not.toContain("node:fs");
    });

    test("node:fs should NOT be in SSR bundle", async () => {
      const ssrBundle = getSsrBundleContent();

      expect(ssrBundle).not.toContain("readFileSync");
    });

    test("changelog content should NOT be in client bundle", async () => {
      const clientBundle = getClientBundleContent();

      // The changelog JSON data is build-time only
      expect(clientBundle).not.toContain("Added pre-rendering support");
      expect(clientBundle).not.toContain("Cache middleware");
      expect(clientBundle).not.toContain("Initial release");
    });

    test("changelog prerender data should exist in manifest", async () => {
      const manifestPath = join(
        TEST_APP_ROOT,
        "dist/rsc/__prerender-manifest.js",
      );
      expect(existsSync(manifestPath)).toBe(true);

      const manifestCode = readFileSync(manifestPath, "utf-8");

      // Should contain a changelog route entry
      expect(manifestCode).toMatch(/"changelog\//);
    });
  });
});
