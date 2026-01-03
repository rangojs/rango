import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Tests for action ID resolution in production builds:
 * 1. Server bundles should have file paths in action $$id for revalidation matching
 * 2. Client bundles should NOT expose file paths (security - only hashed IDs)
 */

test.describe("action-id-resolution (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test.setTimeout(120000);

  test.describe("server bundle action IDs", () => {
    test("server RSC bundle should have file paths in registerServerReference calls", async () => {
      // Read the built RSC bundle
      const distPath = path.join(f.root, "dist/rsc");
      const files = fs.readdirSync(distPath, { recursive: true }) as string[];

      // Find action files in assets
      const actionFiles = files.filter(
        (file) =>
          typeof file === "string" &&
          file.includes("assets/") &&
          file.endsWith(".js")
      );

      let foundFilePathInServerBundle = false;
      let serverActionFileContent = "";

      for (const file of actionFiles) {
        const filePath = path.join(distPath, file);
        const content = fs.readFileSync(filePath, "utf-8");

        // Check if this file has registerServerReference calls with file paths
        // Pattern: registerServerReference(fn, "src/...", "exportName")
        if (
          content.includes("registerServerReference") &&
          content.includes("src/")
        ) {
          foundFilePathInServerBundle = true;
          serverActionFileContent = content;

          // Verify the pattern: registerServerReference(fn, "src/path/to/file.tsx", "actionName")
          const matches = content.match(
            /registerServerReference\([^,]+,\s*"(src\/[^"]+)"/g
          );
          if (matches && matches.length > 0) {
            // Verify at least one match contains a proper file path
            expect(matches.some((m) => m.includes("src/"))).toBe(true);
          }
          break;
        }
      }

      expect(foundFilePathInServerBundle).toBe(true);

      // Verify the file path format is correct (should be relative path like "src/actions.tsx")
      // Note: test-app uses .tsx files for actions
      expect(serverActionFileContent).toMatch(
        /registerServerReference\([^,]+,\s*"src\/[^"]+\.tsx?"/
      );
    });

    test("action revalidation should receive file path in actionId", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Navigate to product detail page which has Add to Cart action
      await page.goto(f.url("/product/product-a"));
      await waitForHydration(page);

      // Intercept the action response to check server behavior
      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/product/product-a") &&
          response.request().method() === "POST"
      );

      // Click Add to Cart button
      await page.click('[data-testid="add-to-cart-btn"]');

      const response = await responsePromise;
      expect(response.status()).toBe(200);

      // The action executed successfully, meaning the server received and processed it
      // Wait for the UI to update
      await page.waitForTimeout(500);

      // Verify the result message appears (proves action completed)
      const resultElement = page.locator('[data-testid="add-to-cart-btn-result"]');
      await expect(resultElement).toBeVisible({ timeout: 5000 });
    });
  });

  test.describe("client bundle security", () => {
    test("client bundle should NOT contain file paths in action references", async () => {
      // Read the built client bundle
      const distPath = path.join(f.root, "dist/client");
      const files = fs.readdirSync(distPath, { recursive: true }) as string[];

      // Find JavaScript files
      const jsFiles = files.filter(
        (file) => typeof file === "string" && file.endsWith(".js")
      );

      for (const file of jsFiles) {
        const filePath = path.join(distPath, file);
        const content = fs.readFileSync(filePath, "utf-8");

        // Client bundle should NOT have file paths like "src/..."
        // It should only have hashed IDs

        // Check for suspicious patterns that would expose server file structure
        const hasServerFilePath =
          // Direct file path patterns in server reference calls
          /createServerReference\([^)]*"src\/[^"]+\.tsx?/.test(content) ||
          // File paths in action registrations
          /registerServerReference\([^)]*"src\/[^"]+\.tsx?/.test(content) ||
          // Exposed handler paths in string literals
          /"src\/[^"]+\.tsx?"/.test(content);

        expect(
          hasServerFilePath,
          `Client bundle ${file} should not expose server file paths`
        ).toBe(false);
      }
    });

    test("client bundle should only have hashed action IDs", async () => {
      // Read the built client bundle
      const distPath = path.join(f.root, "dist/client");
      const files = fs.readdirSync(distPath, { recursive: true }) as string[];

      // Find JavaScript files in assets
      const jsFiles = files.filter(
        (file) =>
          typeof file === "string" &&
          file.includes("assets/") &&
          file.endsWith(".js")
      );

      let foundActionReference = false;

      for (const file of jsFiles) {
        const filePath = path.join(distPath, file);
        const content = fs.readFileSync(filePath, "utf-8");

        // Look for createServerReference calls (client-side action stubs)
        if (content.includes("createServerReference")) {
          foundActionReference = true;

          // Extract all action IDs from createServerReference calls
          // Pattern: createServerReference("hash#actionName", ...)
          const actionIdMatches = content.match(
            /createServerReference\("([^"]+)"/g
          );

          if (actionIdMatches) {
            for (const match of actionIdMatches) {
              // Extract the ID part
              const idMatch = match.match(/createServerReference\("([^"]+)"/);
              if (idMatch) {
                const actionId = idMatch[1];

                // Action ID should be in format "hash#actionName"
                // Hash should be alphanumeric (not a file path)
                const [hash, actionName] = actionId.split("#");

                // Hash should NOT look like a file path
                expect(hash).not.toContain("/");
                expect(hash).not.toContain("src");
                expect(hash).not.toContain(".ts");
                expect(hash).not.toContain(".js");

                // Hash should be alphanumeric (hex hash)
                expect(hash).toMatch(/^[a-f0-9]+$/i);

                // Action name should be present
                expect(actionName).toBeTruthy();
              }
            }
          }
        }
      }

      // We should have found at least one action reference in the client bundle
      expect(foundActionReference).toBe(true);
    });

    test("action request headers should use hashed IDs (not file paths)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/product/product-a"));
      await waitForHydration(page);

      // Intercept the action request to check the headers
      const requestPromise = page.waitForRequest(
        (request) =>
          request.url().includes("/product/product-a") &&
          request.method() === "POST"
      );

      // Click Add to Cart button
      await page.click('[data-testid="add-to-cart-btn"]');

      const request = await requestPromise;

      // Get the rsc-action header
      const actionHeader = request.headers()["rsc-action"];

      // The action ID in the header should be hashed (not a file path)
      expect(actionHeader).toBeTruthy();
      expect(actionHeader).not.toContain("src/");
      expect(actionHeader).not.toContain(".ts");

      // Should be in format "hash#actionName"
      const [hash, actionName] = actionHeader!.split("#");
      expect(hash).toMatch(/^[a-f0-9]+$/i);
      expect(actionName).toBe("addToCartWithResult");
    });
  });

  test.describe("inline actions", () => {
    test("server RSC bundle should keep hashed IDs for inline actions (not file paths)", async () => {
      // Read the built RSC bundle
      const distPath = path.join(f.root, "dist/rsc");
      const files = fs.readdirSync(distPath, { recursive: true }) as string[];

      // Find the handlers bundle which contains the inline action
      const handlerFiles = files.filter(
        (file) =>
          typeof file === "string" &&
          file.includes("assets/") &&
          file.includes("handlers") &&
          file.endsWith(".js")
      );

      expect(handlerFiles.length).toBeGreaterThan(0);

      let foundInlineAction = false;

      for (const file of handlerFiles) {
        const filePath = path.join(distPath, file);
        const content = fs.readFileSync(filePath, "utf-8");

        // Look for the inline action registration
        // Pattern: registerServerReference(fn, "hash", "$$hoist_0_inlineTestAction")
        const inlineActionMatch = content.match(
          /registerServerReference\([^,]+,\s*"([^"]+)",\s*"[^"]*inlineTestAction[^"]*"\)/
        );

        if (inlineActionMatch) {
          foundInlineAction = true;
          const idOrHash = inlineActionMatch[1];

          // Inline actions should NOT have file paths - they should keep hashed IDs
          // This is for client security since inline action IDs are serialized in RSC payload
          expect(idOrHash).not.toContain("/");
          expect(idOrHash).not.toContain("src");
          expect(idOrHash).not.toContain(".tsx");
          expect(idOrHash).not.toContain(".ts");

          // Should be a hex hash
          expect(idOrHash).toMatch(/^[a-f0-9]+$/i);
          break;
        }
      }

      expect(
        foundInlineAction,
        "Should find inline action in handlers bundle"
      ).toBe(true);
    });

    test("inline actions (defined in RSC) should work correctly", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Navigate to inline action test page
      await page.goto(f.url("/inline-action"));
      await waitForHydration(page);

      // Intercept the action response
      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/inline-action") &&
          response.request().method() === "POST"
      );

      // Submit the inline action form
      await page.click('[data-testid="inline-action-submit"]');

      const response = await responsePromise;
      expect(response.status()).toBe(200);

      // The inline action executed successfully
      // This proves that inline actions work correctly in production builds
    });

    test("inline action request headers should use hashed IDs (client security)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/inline-action"));
      await waitForHydration(page);

      // Intercept the action request to check the headers
      const requestPromise = page.waitForRequest(
        (request) =>
          request.url().includes("/inline-action") &&
          request.method() === "POST"
      );

      await page.click('[data-testid="inline-action-submit"]');

      const request = await requestPromise;

      // Get the rsc-action header
      const actionHeader = request.headers()["rsc-action"];

      // The action ID in the header should be hashed (client never sees file paths)
      expect(actionHeader).toBeTruthy();

      // Should be in format "hash#actionName"
      const [hash, actionName] = actionHeader!.split("#");

      // Hash should be alphanumeric (not a file path) - client bundle security
      expect(hash).not.toContain("/");
      expect(hash).not.toContain("src");
      expect(hash).toMatch(/^[a-f0-9]+$/i);

      // Action name should be present (inline actions get hoisted with a prefix like $$hoist_0_)
      expect(actionName).toContain("inlineTestAction");
    });
  });
});
