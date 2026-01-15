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
        `Client assets not found. Run 'pnpm build' in ${TEST_APP_ROOT} first.`
      );
    }
  });

  function getClientBundleContent(): string {
    const files = readdirSync(CLIENT_ASSETS_DIR).filter((f) =>
      f.endsWith(".js")
    );
    return files
      .map((file) => readFileSync(join(CLIENT_ASSETS_DIR, file), "utf-8"))
      .join("\n");
  }

  function getRscBundleContent(): string {
    const files = readdirSync(RSC_ASSETS_DIR).filter((f) => f.endsWith(".js"));
    return files
      .map((file) => readFileSync(join(RSC_ASSETS_DIR, file), "utf-8"))
      .join("\n");
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

      // LoaderBoundary component should exist (it's a client component)
      expect(clientBundle).toContain("LoaderBoundary");

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

      // Cart state should be in RSC bundle
      expect(rscBundle).toContain("cartItems");

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

  test.describe("version-virtual-module", () => {
    function getRscIndexContent(): string {
      return readFileSync(RSC_INDEX, "utf-8");
    }

    test("VERSION should be in RSC bundle as hex string", async () => {
      const rscIndex = getRscIndexContent();

      // VERSION should be defined as const VERSION = "hexstring"
      expect(rscIndex).toMatch(/const VERSION\s*=\s*["'][0-9a-f]+["']/i);
    });

    test("VERSION should be a valid hex timestamp", async () => {
      const rscIndex = getRscIndexContent();

      // Extract VERSION value from const declaration
      const versionMatch = rscIndex.match(/const VERSION\s*=\s*["']([0-9a-f]+)["']/i);
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
      const rscIndex = getRscIndexContent();

      // Extract the actual VERSION from RSC bundle
      const versionMatch = rscIndex.match(/const VERSION\s*=\s*["']([0-9a-f]+)["']/i);
      expect(versionMatch).toBeTruthy();

      const version = versionMatch![1];

      // The specific version string should not appear in client bundle
      expect(clientBundle).not.toContain(version);
    });
  });
});
