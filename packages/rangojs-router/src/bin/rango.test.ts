import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

describe("rango extract-names CLI", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rango-cli-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runCli(dir: string, extraArgs: string[] = []): string {
    const cliPath = join(__dirname, "rango.ts");
    return execFileSync(
      "npx",
      ["tsx", cliPath, "extract-names", dir, ...extraArgs],
      { encoding: "utf-8", timeout: 15000 }
    );
  }

  it("generates per-module .gen.ts and combined named-routes.gen.ts", () => {
    const urlsFile = join(tmpDir, "urls.ts");
    writeFileSync(
      urlsFile,
      `
      import { urls } from "@rangojs/router";
      export const patterns = urls(({ path }) => [
        path("/", () => null, { name: "home" }),
        path("/about", () => null, { name: "about" }),
      ]);
    `
    );

    const routerFile = join(tmpDir, "router.tsx");
    writeFileSync(
      routerFile,
      `
      import { createRouter } from "@rangojs/router";
      import { patterns } from "./urls";
      export default createRouter().routes(patterns);
    `
    );

    const output = runCli(tmpDir);
    expect(output).toContain("Scanning");

    // Per-module .gen.ts should exist
    const perModuleGen = join(tmpDir, "urls.gen.ts");
    expect(existsSync(perModuleGen)).toBe(true);
    const perModuleContent = readFileSync(perModuleGen, "utf-8");
    expect(perModuleContent).toContain(`home: "/"`);
    expect(perModuleContent).toContain(`about: "/about"`);

    // Combined named-routes.gen.ts should exist
    const combinedGen = join(tmpDir, "router.named-routes.gen.ts");
    expect(existsSync(combinedGen)).toBe(true);
    const combinedContent = readFileSync(combinedGen, "utf-8");
    expect(combinedContent).toContain("export const NamedRoutes");
    expect(combinedContent).toContain(`home: "/"`);
    expect(combinedContent).toContain(`about: "/about"`);
    expect(combinedContent).toContain("GeneratedRouteMap");
  });

  it("generates combined file with include-prefixed routes", () => {
    const apiUrlsFile = join(tmpDir, "api-urls.ts");
    writeFileSync(
      apiUrlsFile,
      `
      import { urls } from "@rangojs/router";
      export const apiPatterns = urls(({ path }) => [
        path("/users", () => null, { name: "users" }),
        path("/posts", () => null, { name: "posts" }),
      ]);
    `
    );

    const urlsFile = join(tmpDir, "urls.ts");
    writeFileSync(
      urlsFile,
      `
      import { urls } from "@rangojs/router";
      import { apiPatterns } from "./api-urls";
      export const patterns = urls(({ path, include }) => [
        path("/", () => null, { name: "home" }),
        include("/api", apiPatterns, { name: "api" }),
      ]);
    `
    );

    const routerFile = join(tmpDir, "router.tsx");
    writeFileSync(
      routerFile,
      `
      import { createRouter } from "@rangojs/router";
      import { patterns } from "./urls";
      export default createRouter().routes(patterns);
    `
    );

    runCli(tmpDir);

    const combinedGen = join(tmpDir, "router.named-routes.gen.ts");
    expect(existsSync(combinedGen)).toBe(true);
    const content = readFileSync(combinedGen, "utf-8");
    expect(content).toContain(`"api.posts": "/api/posts"`);
    expect(content).toContain(`"api.users": "/api/users"`);
    expect(content).toContain(`home: "/"`);
  });

  it("--static-only skips runtime discovery and uses static parsing", () => {
    const urlsFile = join(tmpDir, "urls.ts");
    writeFileSync(
      urlsFile,
      `
      import { urls } from "@rangojs/router";
      export const patterns = urls(({ path }) => [
        path("/", () => null, { name: "home" }),
      ]);
    `
    );

    const routerFile = join(tmpDir, "router.tsx");
    writeFileSync(
      routerFile,
      `
      import { createRouter } from "@rangojs/router";
      import { patterns } from "./urls";
      export default createRouter().routes(patterns);
    `
    );

    const output = runCli(tmpDir, ["--static-only"]);
    expect(output).toContain("static only");

    const combinedGen = join(tmpDir, "router.named-routes.gen.ts");
    expect(existsSync(combinedGen)).toBe(true);
    const content = readFileSync(combinedGen, "utf-8");
    expect(content).toContain(`home: "/"`);
  });

  it("falls back to static parsing when runtime discovery fails in temp dir", () => {
    // In a temp directory without proper Vite/RSC setup, runtime discovery
    // should fail gracefully and fall back to static parsing
    const urlsFile = join(tmpDir, "urls.ts");
    writeFileSync(
      urlsFile,
      `
      import { urls } from "@rangojs/router";
      export const patterns = urls(({ path }) => [
        path("/fallback-test", () => null, { name: "fallback" }),
      ]);
    `
    );

    const routerFile = join(tmpDir, "router.tsx");
    writeFileSync(
      routerFile,
      `
      import { createRouter } from "@rangojs/router";
      import { patterns } from "./urls";
      export default createRouter().routes(patterns);
    `
    );

    const output = runCli(tmpDir);
    // Should have fallen back to static parsing (runtime discovery will fail
    // because the temp dir doesn't have node_modules/@vitejs/plugin-rsc)
    expect(output).toContain("Scanning");

    const combinedGen = join(tmpDir, "router.named-routes.gen.ts");
    expect(existsSync(combinedGen)).toBe(true);
    const content = readFileSync(combinedGen, "utf-8");
    expect(content).toContain(`fallback: "/fallback-test"`);
  });
});
