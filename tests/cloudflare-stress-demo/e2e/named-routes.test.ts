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
    expect(content).toContain(
      '"shop.product.benchFirst": "/shop/product/bench/first"',
    );

    // Routes from lazy include("/shop", ...) -> include("/category", ...)
    expect(content).toContain(
      '"shop.category.benchFirst": "/shop/category/bench/first"',
    );
  });

  test("should resolve all dynamically generated routes (25k+)", async () => {
    const content = await fs.readFile(genFilePath, "utf-8");

    // Count route entries — the stress demo generates its routes via
    // Array.from loops (original ~14k) plus the scripts/gen-groups.mjs hub
    // groups (50 x ~240) that the static parser cannot see. Runtime
    // discovery resolves all of them; 26,363 at the current scale.
    const routeLines = content.match(/^\s+["a-zA-Z_$][^:]*: "[^"]+",$/gm);
    expect(routeLines).not.toBeNull();
    expect(routeLines!.length).toBeGreaterThanOrEqual(25000);
  });

  test("should contain hub, mega-chain, and overlap-group routes", async () => {
    const content = await fs.readFile(genFilePath, "utf-8");

    // Sibling async includes via the /g hub (generated groups)
    expect(content).toContain('"g.g001.benchFirst": "/g/g001/bench/first"');
    expect(content).toContain('"g.g050.benchLast": "/g/g050/bench/last"');
    // Catch-alls and suffix params inside a generated group
    expect(content).toContain('"g.g001.tree": "/g/g001/tree/:rest+"');
    expect(content).toContain('"g.g001.blob": "/g/g001/blob/:rest*"');
    expect(content).toContain(
      '"g.g001.fileMinJs": "/g/g001/files/:file.min.js"',
    );
    // 3-level async include chain
    expect(content).toContain('"mega.l2.l3.p1": "/mega/l2/l3/p1/:id?"');
    // String-prefix overlap group and same-staticPrefix pair
    expect(content).toContain('"siteAdmin.p1": "/site-admin/p1"');
    expect(content).toContain('"dupCat.catPage1": "/dup/:cat/cat-page1"');
    expect(content).toContain(
      '"dupBrand.brandPage1": "/dup/:brand/brand-page1"',
    );
  });

  test("should not have double-slash patterns", async () => {
    const content = await fs.readFile(genFilePath, "utf-8");
    const doubleSlashLines = content.match(/: "\/\//gm);
    expect(doubleSlashLines).toBeNull();
  });
});
