import { describe, it, expect, afterEach } from "vitest";
import {
  injectClientDebugFlag,
  internalDebugNoCacheMiddleware,
} from "../inject-client-debug";

// injectClientDebugFlag is the discovery plugin's `transform` for the router's
// internal-debug module. It bakes the resolved INTERNAL_RANGO_DEBUG flag into the
// client module so FE debug no longer depends on Vite delivering the
// __RANGO_DEBUG__ define to the client. It is mode-independent (the discovery
// plugin runs it in both dev and build), so these cases pin the dev AND build
// behavior the e2e fixtures cannot exercise.
describe("injectClientDebugFlag", () => {
  const original = process.env.INTERNAL_RANGO_DEBUG;
  afterEach(() => {
    if (original === undefined) delete process.env.INTERNAL_RANGO_DEBUG;
    else process.env.INTERNAL_RANGO_DEBUG = original;
  });

  // A published consumer resolves the router into node_modules; the monorepo
  // resolves it to the workspace source. Both must match.
  const NODE_MODULES_ID =
    "/app/node_modules/@rangojs/router/src/internal-debug.ts";
  const WORKSPACE_ID = "/repo/packages/rangojs-router/src/internal-debug.ts";

  it("bakes `true` when the env var is set (node_modules consumer)", () => {
    process.env.INTERNAL_RANGO_DEBUG = "true";
    expect(injectClientDebugFlag(NODE_MODULES_ID)?.code).toBe(
      "export const INTERNAL_RANGO_DEBUG = true;\n",
    );
  });

  it("bakes `false` when the env var is unset", () => {
    delete process.env.INTERNAL_RANGO_DEBUG;
    expect(injectClientDebugFlag(WORKSPACE_ID)?.code).toBe(
      "export const INTERNAL_RANGO_DEBUG = false;\n",
    );
  });

  it("matches the workspace path", () => {
    process.env.INTERNAL_RANGO_DEBUG = "1";
    expect(injectClientDebugFlag(WORKSPACE_ID)?.code).toContain(
      "INTERNAL_RANGO_DEBUG = true",
    );
  });

  it("matches a ?query-suffixed module id", () => {
    process.env.INTERNAL_RANGO_DEBUG = "true";
    expect(
      injectClientDebugFlag(`${NODE_MODULES_ID}?v=abc123`)?.code,
    ).toContain("INTERNAL_RANGO_DEBUG = true");
  });

  it("returns null for unrelated modules", () => {
    process.env.INTERNAL_RANGO_DEBUG = "true";
    expect(
      injectClientDebugFlag("/repo/packages/rangojs-router/src/router.ts"),
    ).toBeNull();
    expect(
      injectClientDebugFlag("/app/node_modules/other-pkg/internal-debug.ts"),
    ).toBeNull();
  });

  it("does not match an internal-debug file outside the router package", () => {
    process.env.INTERNAL_RANGO_DEBUG = "true";
    expect(injectClientDebugFlag("/app/src/internal-debug.ts")).toBeNull();
    // A consumer dir merely *named* rangojs-router must not match -- the path is
    // anchored to /packages/rangojs-router/ or /@rangojs/router/, not a bare
    // /rangojs-router/ segment.
    expect(
      injectClientDebugFlag("/work/rangojs-router/internal-debug.ts"),
    ).toBeNull();
  });
});

// internalDebugNoCacheMiddleware forces `no-cache` for the internal-debug URL so
// browsers revalidate it instead of trusting dev's immutable `?v=` caching of
// node_modules files -- see its JSDoc in ../inject-client-debug.ts for the full
// failure story. The assertions simulate Vite's transform middleware setting the
// immutable header AFTER next().
describe("internalDebugNoCacheMiddleware", () => {
  const IMMUTABLE = "max-age=31536000,immutable";

  function run(
    url: string,
    cacheControlName = "Cache-Control",
  ): Record<string, unknown> {
    const headers: Record<string, unknown> = {};
    const res = {
      setHeader(name: string, value: unknown) {
        headers[name] = value;
        return res;
      },
    };
    const mw = internalDebugNoCacheMiddleware();
    mw({ url } as any, res as any, () => {
      // Vite's transform middleware sets headers after our middleware ran.
      res.setHeader(cacheControlName, IMMUTABLE);
      res.setHeader("Etag", 'W/"2a-abc"');
    });
    return headers;
  }

  it("rewrites Cache-Control to no-cache for the consumer @fs URL", () => {
    const headers = run(
      "/@fs/app/node_modules/@rangojs/router/src/internal-debug.ts?v=d7d90f0d",
    );
    expect(headers["Cache-Control"]).toBe("no-cache");
    expect(headers["Etag"]).toBe('W/"2a-abc"');
  });

  it("rewrites for the workspace URL", () => {
    const headers = run(
      "/@fs/repo/packages/rangojs-router/src/internal-debug.ts",
    );
    expect(headers["Cache-Control"]).toBe("no-cache");
  });

  it("is case-insensitive on the header name", () => {
    const headers = run(
      "/@fs/app/node_modules/@rangojs/router/src/internal-debug.ts?v=1",
      "cache-control",
    );
    expect(headers["cache-control"]).toBe("no-cache");
  });

  it("leaves unrelated URLs untouched", () => {
    const headers = run(
      "/@fs/app/node_modules/@rangojs/router/src/browser/logging.ts?v=d7d90f0d",
    );
    expect(headers["Cache-Control"]).toBe(IMMUTABLE);
  });

  it("does not match a consumer file outside the router package", () => {
    const headers = run("/@fs/app/src/internal-debug.ts?v=abc");
    expect(headers["Cache-Control"]).toBe(IMMUTABLE);
  });
});
