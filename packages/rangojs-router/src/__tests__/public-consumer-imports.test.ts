import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const tscBin = resolve(packageRoot, "node_modules", ".bin", "tsc");
const packageJson = JSON.parse(
  readFileSync(resolve(packageRoot, "package.json"), "utf-8"),
) as {
  exports: Record<string, { types?: string }>;
};
const tempDirs: string[] = [];

function publicTypeEntry(subpath: string): string {
  const entry = packageJson.exports[subpath]?.types;
  if (!entry) {
    throw new Error(`Missing types export for ${subpath}`);
  }
  return entry;
}

function runConsumerTypecheck(files: Record<string, string>) {
  const tempDir = mkdtempSync(join(tmpdir(), "rango-public-consumer-"));
  tempDirs.push(tempDir);

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
          baseUrl: packageRoot,
          paths: {
            "@rangojs/router": [publicTypeEntry(".")],
            "@rangojs/router/client": [publicTypeEntry("./client")],
            "@rangojs/router/cache": [publicTypeEntry("./cache")],
            "@rangojs/router/host": [publicTypeEntry("./host")],
            "@rangojs/router/host/testing": [publicTypeEntry("./host/testing")],
            "@rangojs/router/theme": [publicTypeEntry("./theme")],
            "@rangojs/router/vite": [publicTypeEntry("./vite")],
            "@rangojs/router/rsc": [publicTypeEntry("./rsc")],
            "@rangojs/router/ssr": [publicTypeEntry("./ssr")],
            "@rangojs/router/testing": [publicTypeEntry("./testing")],
            "@rangojs/router/testing/dom": [publicTypeEntry("./testing/dom")],
            "@rangojs/router/testing/e2e": [publicTypeEntry("./testing/e2e")],
            "@rangojs/router/testing/flight": [
              publicTypeEntry("./testing/flight"),
            ],
          },
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

describe("public consumer imports", () => {
  it("typechecks the canonical public import paths", () => {
    const result = runConsumerTypecheck({
      "root-consumer.ts": `
import { createLoader, createRouter, redirect, urls } from "@rangojs/router";
import type { ActionRef } from "@rangojs/router";

void createLoader;
void createRouter;
void redirect;
void urls;
type _ActionRef = ActionRef;
`,
      "client-consumer.tsx": `
import { Link, Outlet, href, useLoader, useRouter } from "@rangojs/router/client";

export function Example() {
  void useLoader;
  void useRouter;
  return (
    <>
      <Link to={href("/")}>Home</Link>
      <Outlet />
    </>
  );
}
`,
      "cache-consumer.ts": `
import {
  CFCacheStore,
  MemorySegmentCacheStore,
  createCacheScope,
} from "@rangojs/router/cache";

void CFCacheStore;
void MemorySegmentCacheStore;
void createCacheScope;
`,
      "host-consumer.ts": `
import { NoRouteMatchError, createHostRouter } from "@rangojs/router/host";
import { createTestRequest } from "@rangojs/router/host/testing";

void NoRouteMatchError;
void createHostRouter;
void createTestRequest;
`,
      "theme-consumer.tsx": `
import { THEME_COOKIE, ThemeScript, useTheme } from "@rangojs/router/theme";

void THEME_COOKIE;
void useTheme;
void ThemeScript;
`,
      "vite-consumer.ts": `
import { rango, type RangoOptions } from "@rangojs/router/vite";

const options: RangoOptions = { preset: "cloudflare" };
void rango;
void options;
`,
      "rsc-consumer.ts": `
import {
  createRSCHandler,
  getRequestContext,
  requireRequestContext,
  type CreateRSCHandlerOptions,
} from "@rangojs/router/rsc";

void createRSCHandler;
void getRequestContext;
void requireRequestContext;
type _Options = CreateRSCHandlerOptions;
`,
      "ssr-consumer.ts": `
import {
  createSSRHandler,
  type SSRDependencies,
  type SSRRenderOptions,
} from "@rangojs/router/ssr";

void createSSRHandler;
type _Deps = SSRDependencies;
type _RenderOptions = SSRRenderOptions;
`,
      "testing-consumer.ts": `
import {
  runMiddleware,
  runLoader,
  dispatch,
  assertCacheStatus,
  assertGeneratedRoutesMatch,
  createCacheSink,
} from "@rangojs/router/testing";
import { renderRoute } from "@rangojs/router/testing/dom";
import { createRangoE2E } from "@rangojs/router/testing/e2e";
import { renderToFlightString, flightMatchers } from "@rangojs/router/testing/flight";

void runMiddleware;
void runLoader;
void dispatch;
void renderRoute;
void assertCacheStatus;
void assertGeneratedRoutesMatch;
void createCacheSink;
void createRangoE2E;
void renderToFlightString;
void flightMatchers;
`,
    });

    expect(result.status).toBe(0);
  }, 20_000);

  it("rejects client component imports from the root entrypoint", () => {
    const result = runConsumerTypecheck({
      "invalid-root-client-import.ts": `
import { Outlet } from "@rangojs/router";

void Outlet;
`,
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("@rangojs/router");
    expect(result.output).toContain("Outlet");
  }, 20_000);

  it("rejects non-exported deep cache subpaths", () => {
    const result = runConsumerTypecheck({
      "invalid-cache-deep-import.ts": `
import { CFCacheStore } from "@rangojs/router/cache/cf";

void CFCacheStore;
`,
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("@rangojs/router/cache/cf");
  }, 20_000);

  it("rejects internal host router registry imports from the public host subpath", () => {
    const result = runConsumerTypecheck({
      "invalid-host-registry-import.ts": `
import { HostRouterRegistry } from "@rangojs/router/host";

void HostRouterRegistry;
`,
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("HostRouterRegistry");
    expect(result.output).toContain("@rangojs/router/host");
  }, 20_000);

  it("rejects theme implementation helpers from the public theme subpath", () => {
    const result = runConsumerTypecheck({
      "invalid-theme-internals.ts": `
import { ThemeContext, generateThemeScript } from "@rangojs/router/theme";

void ThemeContext;
void generateThemeScript;
`,
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("@rangojs/router/theme");
    expect(result.output).toContain("ThemeContext");
  }, 20_000);

  it("rejects internal request-context and cache-store helpers from the rsc subpath", () => {
    const result = runConsumerTypecheck({
      "invalid-rsc-internals.ts": `
import {
  MemorySegmentCacheStore,
  createHandleStore,
  setRequestContextParams,
} from "@rangojs/router/rsc";

void MemorySegmentCacheStore;
void createHandleStore;
void setRequestContextParams;
`,
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("@rangojs/router/rsc");
    expect(result.output).toContain("MemorySegmentCacheStore");
  }, 20_000);
});
