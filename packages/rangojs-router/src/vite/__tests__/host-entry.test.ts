import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVirtualEntriesPlugin } from "../utils/shared-utils.js";
import {
  VIRTUAL_IDS,
  getVirtualEntryRSCHost,
} from "../plugins/virtual-entries.js";
import {
  findRouterFiles,
  findHostRouterFiles,
} from "../../build/route-types/router-processing.js";

const loadRsc = (routerPathRef: {
  path?: string;
  kind?: "router" | "host";
}): string => {
  const plugin = createVirtualEntriesPlugin(
    { client: "client.tsx", ssr: "ssr.tsx", rsc: VIRTUAL_IDS.rsc },
    routerPathRef,
  );
  const load = (plugin as any).load as (id: string) => string | null;
  const result = load("\0" + VIRTUAL_IDS.rsc);
  expect(result).toBeTruthy();
  return result as string;
};

describe("getVirtualEntryRSCHost", () => {
  it("serves the host router via match(), not createRSCHandler", () => {
    const code = getVirtualEntryRSCHost("/src/worker.rsc.tsx");
    expect(code).toContain(
      'import * as __hostEntry from "/src/worker.rsc.tsx"',
    );
    expect(code).toContain("hostRouter.match(request, input)");
    // It must NOT wrap a single router in createRSCHandler like the router entry.
    expect(code).not.toContain("createRSCHandler");
    // Accepts the instance as default or a named hostRouter/router export,
    // resolved DYNAMICALLY (m[name]) so Rollup does not warn IMPORT_IS_UNDEFINED
    // for the named exports a default-only host module omits.
    expect(code).toContain('"default"');
    expect(code).toContain('"hostRouter"');
    expect(code).toContain('"router"');
    expect(code).not.toContain("__hostEntry.hostRouter");
    expect(code).not.toContain("__hostEntry.router");
    // Rejects a Cloudflare-style { fetch } object with a clear error.
    expect(code).toContain("must export a HostRouter instance");
    // Still registers all sub-app manifests/loaders at startup.
    expect(code).toContain('import "virtual:rsc-router/loader-manifest"');
    expect(code).toContain('import "virtual:rsc-router/routes-manifest"');
  });

  it("catches NoRouteMatchError and returns 404 (rango owns the entry)", () => {
    const code = getVirtualEntryRSCHost("/src/worker.rsc.tsx");
    // node/vercel users no longer own the worker wrapper, so an unmatched host
    // must not surface as an unhandled throw (500).
    expect(code).toContain(
      'import { NoRouteMatchError } from "@rangojs/router/host"',
    );
    expect(code).toContain("err instanceof NoRouteMatchError");
    expect(code).toContain("status: 404");
  });
});

describe("createVirtualEntriesPlugin entry kind", () => {
  it('renders the single-router entry for kind "router" (default)', () => {
    const router = loadRsc({ path: "./src/router.tsx", kind: "router" });
    expect(router).toContain("createRSCHandler");
    expect(router).toContain('import { router } from "/src/router.tsx"');
    expect(router).not.toContain("hostRouter.match");

    // Omitting kind behaves as the single-router entry (back-compat).
    const legacy = loadRsc({ path: "./src/router.tsx" });
    expect(legacy).toContain("createRSCHandler");
  });

  it('renders the host entry for kind "host"', () => {
    const host = loadRsc({ path: "./src/worker.rsc.tsx", kind: "host" });
    expect(host).toContain("hostRouter.match(request, input)");
    expect(host).toContain(
      'import * as __hostEntry from "/src/worker.rsc.tsx"',
    );
    expect(host).not.toContain("createRSCHandler");
  });
});

describe("findHostRouterFiles", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rango-host-"));
    // Host entry above the sub-apps.
    writeFileSync(
      join(root, "worker.rsc.tsx"),
      `import { createHostRouter } from "@rangojs/router/host";\n` +
        `export const hostRouter = createHostRouter();\n` +
        `hostRouter.host(["localhost/a"]).lazy(() => import("./apps/a/router.js"));\n`,
    );
    mkdirSync(join(root, "apps", "a"), { recursive: true });
    mkdirSync(join(root, "apps", "b"), { recursive: true });
    writeFileSync(
      join(root, "apps", "a", "router.tsx"),
      `import { createRouter } from "@rangojs/router";\nexport const router = createRouter();\n`,
    );
    writeFileSync(
      join(root, "apps", "b", "router.tsx"),
      `import { createRouter } from "@rangojs/router";\nexport const router = createRouter();\n`,
    );
    // A file only mentioning createHostRouter in a comment must NOT match.
    writeFileSync(
      join(root, "notes.tsx"),
      `// createHostRouter() is configured in worker.rsc.tsx\nexport const x = 1;\n`,
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds the createHostRouter() entry, skipping comment-only mentions", () => {
    const hosts = findHostRouterFiles(root);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatch(/worker\.rsc\.tsx$/);
  });

  it("does not stop at sub-app router roots (still finds both createRouter sub-apps)", () => {
    // The multi-app shape that previously threw 'Multiple routers found':
    const routers = findRouterFiles(root);
    expect(routers).toHaveLength(2);
    expect(routers.some((f) => /apps[\\/]a[\\/]router\.tsx$/.test(f))).toBe(
      true,
    );
    expect(routers.some((f) => /apps[\\/]b[\\/]router\.tsx$/.test(f))).toBe(
      true,
    );
  });

  it("detects the host file even with a single createRouter sub-app (host must win)", () => {
    // Regression: a host app with ONE sub-app must still be served via the host
    // entry, not as the raw sub-router. Selection checks findHostRouterFiles
    // before findRouterFiles, so a lone createRouter does not shadow the host.
    const solo = mkdtempSync(join(tmpdir(), "rango-host-solo-"));
    try {
      writeFileSync(
        join(solo, "worker.rsc.tsx"),
        `import { createHostRouter } from "@rangojs/router/host";\n` +
          `export default createHostRouter();\n`,
      );
      mkdirSync(join(solo, "apps", "only"), { recursive: true });
      writeFileSync(
        join(solo, "apps", "only", "router.tsx"),
        `import { createRouter } from "@rangojs/router";\nexport const router = createRouter();\n`,
      );
      expect(findHostRouterFiles(solo)).toHaveLength(1);
      expect(findRouterFiles(solo)).toHaveLength(1);
    } finally {
      rmSync(solo, { recursive: true, force: true });
    }
  });
});
