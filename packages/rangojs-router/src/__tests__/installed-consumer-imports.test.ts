import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const tscBin = resolve(packageRoot, "node_modules", ".bin", "tsc");
const tempDirs: string[] = [];

function setupInstalledConsumer(files: Record<string, string>) {
  const tempDir = mkdtempSync(join(tmpdir(), "rango-installed-consumer-"));
  tempDirs.push(tempDir);

  const packageLinkDir = join(tempDir, "node_modules", "@rangojs");
  mkdirSync(packageLinkDir, { recursive: true });
  symlinkSync(packageRoot, join(packageLinkDir, "router"), "dir");

  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(tempDir, name), content);
  }

  writeFileSync(
    join(tempDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          noEmit: true,
          module: "esnext",
          moduleResolution: "bundler",
          target: "es2022",
          jsx: "react-jsx",
          strict: true,
          skipLibCheck: true,
          typeRoots: [resolve(packageRoot, "node_modules", "@types")],
          types: ["node", "react"],
        },
        include: Object.keys(files),
      },
      null,
      2,
    ),
  );

  const result = spawnSync(tscBin, ["-p", join(tempDir, "tsconfig.json")], {
    cwd: tempDir,
    encoding: "utf-8",
  });

  return {
    ...result,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("installed consumer imports", () => {
  it("typechecks public subpaths through the real package export map", () => {
    const result = setupInstalledConsumer({
      "consumer.tsx": `
import { createLoader, createRouter } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { MemorySegmentCacheStore } from "@rangojs/router/cache";
import { createHostRouter } from "@rangojs/router/host";
import {
  createTestRequest,
  testPattern,
  matchesHost,
} from "@rangojs/router/host/testing";
import { useTheme } from "@rangojs/router/theme";
import { rango, type RangoOptions } from "@rangojs/router/vite";
import { createRSCHandler } from "@rangojs/router/rsc";
import { createSSRHandler } from "@rangojs/router/ssr";
import {
  runLoader,
  runLoaderResult,
  dispatch,
  createTestRequestContext,
  runInRequestContext,
  runWithRequestContext,
} from "@rangojs/router/testing";
import {
  rangoTestAliases,
  rangoTestConfig,
} from "@rangojs/router/testing/vitest";
import { renderRoute } from "@rangojs/router/testing/dom";
import { createRangoE2E } from "@rangojs/router/testing/e2e";
import { renderToFlightString } from "@rangojs/router/testing/flight";
import { flightMatchers } from "@rangojs/router/testing/flight-matchers";

void createLoader;
void createRouter;
void Link;
void MemorySegmentCacheStore;
void createHostRouter;
void createTestRequest;
void testPattern;
void matchesHost;
void useTheme;
void rango;
void createRSCHandler;
void createSSRHandler;
void runLoader;
void runLoaderResult;
void rangoTestAliases;
void rangoTestConfig;
void createTestRequestContext;
void runInRequestContext;
void runWithRequestContext;
void dispatch;
void renderRoute;
void createRangoE2E;
void renderToFlightString;
void flightMatchers;

const options: RangoOptions = { preset: "cloudflare" };
void options;
`,
    });

    expect(result.status).toBe(0);
  }, 20_000);
});
