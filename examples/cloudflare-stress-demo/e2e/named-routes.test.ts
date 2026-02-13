import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const genFilePath = path.resolve("./src/router.named-routes.gen.ts");

test.describe("named-routes", () => {
  test("generated file should export NamedRoutes with all routes", async () => {
    const content = await fs.readFile(genFilePath, "utf-8");

    expect(content).toContain("export const NamedRoutes");
    expect(content).toContain("as const");
    expect(content).toContain("interface GeneratedRouteMap");
  });

  test("should contain routes from all lazy includes", async () => {
    const content = await fs.readFile(genFilePath, "utf-8");

    // Top-level routes
    expect(content).toContain('home: "/"');
    expect(content).toContain('reverseTest: "/reverse-test"');

    // Routes from lazy include("/api", ...)
    expect(content).toContain('"api.benchFirst": "/api/bench/first"');
    expect(content).toContain('"api.benchLast": "/api/bench/last"');

    // Routes from lazy include("/shop", ...) -> include("/product", ...)
    expect(content).toContain('"shop.home": "/shop"');
    expect(content).toContain('"shop.product.benchFirst": "/shop/product/bench/first"');

    // Routes from lazy include("/shop", ...) -> include("/category", ...)
    expect(content).toContain('"shop.category.benchFirst": "/shop/category/bench/first"');
  });

  test("should resolve all dynamically generated routes (10k+)", async () => {
    const content = await fs.readFile(genFilePath, "utf-8");

    // Count route entries — the stress demo generates 14k+ routes via
    // Array.from loops that the static parser cannot see. Runtime discovery
    // resolves all of them.
    const routeLines = content.match(/^\s+["a-zA-Z_$][^:]*: "[^"]+",$/gm);
    expect(routeLines).not.toBeNull();
    expect(routeLines!.length).toBeGreaterThanOrEqual(10000);
  });

  test("should not have double-slash patterns", async () => {
    const content = await fs.readFile(genFilePath, "utf-8");
    const doubleSlashLines = content.match(/: "\/\//gm);
    expect(doubleSlashLines).toBeNull();
  });
});
