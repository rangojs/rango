/**
 * A Static() layout or parallel slot bakes `ctx.reverse(".name")` in the
 * module that declares it, exactly as the same segment resolves it live.
 *
 * Each Static() handler below links with every call shape of `ctx.reverse`.
 * The page is served once with no baked entry (the dev path: the handler runs
 * live with its segment's scoped ctx), then the build's collector
 * (renderStaticHandlers) bakes every Static() definition, and the same page is
 * served again from the baked entries (the production path). Both must show
 * the same links at every depth: the root (no named include), one, two and
 * three named includes deep, for a layout, a slot and a route.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import {
  createRouter,
  Static,
  urls,
  type StaticBuildContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { renderStaticHandlers } from "../../vite/discovery/prerender-collection.js";
import type { DiscoveryState } from "../../vite/discovery/state.js";
import { RANGO_BUILD_DIR } from "../../vite/utils/prerender-utils.js";
import { callShapes } from "./helpers/call-shapes.js";

const PARAMS = { accountId: "acme", projectId: "web", repoId: "core" };

/** `label:<shape>=<url>|...` for every call shape of `ctx.reverse(name)`. */
async function links(
  label: string,
  ctx: StaticBuildContext,
  name: string,
): Promise<React.ReactNode> {
  const results = await Promise.all(
    callShapes(ctx, "reverse").map((shape) =>
      shape.call(name, PARAMS).then(
        (url) => `${shape.name}=${String(url)}`,
        (error: Error) => `${shape.name}!${error.message}`,
      ),
    ),
  );
  return <p>{`${label}:${results.join("|")}`}</p>;
}

const RootShell = Static((ctx) => links("root-layout", ctx, ".home"));
const RootAside = Static((ctx) => links("root-slot", ctx, ".home"));
const AccountShell = Static((ctx) => links("account-layout", ctx, ".settings"));
const AccountAside = Static((ctx) => links("account-slot", ctx, ".settings"));
const ProjectShell = Static((ctx) => links("project-layout", ctx, ".settings"));
const ProjectAside = Static((ctx) => links("project-slot", ctx, ".settings"));
const ProjectIssues = Static((ctx) => links("project-route", ctx, ".settings"));
const RepoShell = Static((ctx) => links("repo-layout", ctx, ".settings"));

const DEFS = {
  RootShell,
  RootAside,
  AccountShell,
  AccountAside,
  ProjectShell,
  ProjectAside,
  ProjectIssues,
  RepoShell,
};

const repoUrls = urls(({ path, layout }) => [
  layout(RepoShell, () => [
    path("/code", () => <article>repo code</article>, { name: "code" }),
    path("/settings", () => <article>repo settings</article>, {
      name: "settings",
    }),
  ]),
]);

const projectUrls = urls(({ path, layout, parallel, include }) => [
  layout(ProjectShell, () => [
    parallel({ "@aside": ProjectAside }),
    path("/issues", ProjectIssues, { name: "issues" }),
    path("/settings", () => <article>project settings</article>, {
      name: "settings",
    }),
    include("/:repoId", repoUrls, { name: "repo" }),
  ]),
]);

const accountUrls = urls(({ path, layout, parallel, include }) => [
  layout(AccountShell, () => [
    parallel({ "@aside": AccountAside }),
    path("/settings", () => <article>account settings</article>, {
      name: "settings",
    }),
    include("/:projectId", projectUrls, { name: "project" }),
  ]),
]);

const router: any = createRouter({ id: "static-reverse-scope" }).routes(
  urls(({ path, layout, parallel, include }) => [
    layout(RootShell, () => [
      parallel({ "@aside": RootAside }),
      path("/", () => <p>home</p>, { name: "home" }),
      include("/:accountId", accountUrls, { name: "account" }),
    ]),
  ]),
);

/**
 * The build's static manifest. Non-empty from the start so the static store
 * is created on the first lookup (it latches null for good on an empty one);
 * a lookup for an id not in it falls through to the live handler, the dev path.
 */
const manifest: Record<string, () => Promise<{ default: unknown }>> = {
  "static-reverse-scope#placeholder": async () => ({ default: "" }),
};
globalThis.__STATIC_MANIFEST = manifest as typeof globalThis.__STATIC_MANIFEST;
afterAll(() => {
  globalThis.__STATIC_MANIFEST = undefined;
});

async function serve(url: string): Promise<string> {
  const result = await serveShellRequest(router, url, {
    cacheStore: new MemorySegmentCacheStore(),
  });
  expect(result.response.status).toBe(200);
  return result.flight ?? "";
}

/** Bakes every Static() definition through the build's collector. */
async function bake(): Promise<void> {
  const projectRoot = mkdtempSync(join(tmpdir(), "rango-static-scope-"));
  const state = {
    opts: { enableBuildPrerender: true },
    isBuildMode: true,
    projectRoot,
    buildData: [],
    resolvedStaticModules: new Map([["static-scope", Object.keys(DEFS)]]),
  } as unknown as DiscoveryState;
  try {
    await renderStaticHandlers(
      state,
      { runner: { import: async () => DEFS } },
      new Map([[router.id, router]]),
    );
    const staged = join(projectRoot, RANGO_BUILD_DIR, "rsc-assets");
    for (const [id, fileName] of Object.entries(
      state.staticManifestEntries ?? {},
    )) {
      const source = readFileSync(join(staged, fileName), "utf8");
      const value: unknown = JSON.parse(
        source.replace(/^export default /, "").replace(/;\n$/, ""),
      );
      manifest[id] = async () => ({ default: value });
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

/** Every `label:...` line the page shows, in label order. */
function linkLines(flight: string): string[] {
  return [
    ...flight.matchAll(/"([a-z]+-(?:layout|slot|route):(?:[^"\\]|\\.)*)"/g),
  ]
    .map((m) => JSON.parse(`"${m[1]!}"`) as string)
    .sort();
}

const SHAPES =
  "method=URL|detached=URL|spread=URL|spread detached=URL|after await=URL|after await detached=URL";
const expected = (label: string, url: string) =>
  `${label}:${SHAPES.replaceAll("URL", url)}`;

const EXPECTED = [
  expected("account-layout", "/acme/settings"),
  expected("account-slot", "/acme/settings"),
  expected("project-layout", "/acme/web/settings"),
  expected("project-route", "/acme/web/settings"),
  expected("project-slot", "/acme/web/settings"),
  expected("repo-layout", "/acme/web/core/settings"),
  expected("root-layout", "/"),
  expected("root-slot", "/"),
];

let consoleSpies: MockInstance[] = [];
beforeEach(() => {
  resetShellTestState();
  consoleSpies = (["log", "warn"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
});
afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
});

describe("Static() ctx.reverse('.name') bakes in the declaring module", () => {
  let devLines: string[];

  it("live (dev): each segment links in its own module", async () => {
    devLines = linkLines(await serve("/acme/web/core/code"));
    const issues = linkLines(await serve("/acme/web/issues"));
    devLines = [...new Set([...devLines, ...issues])].sort();
    expect(devLines).toEqual(EXPECTED);
  });

  it("the build bakes every Static() definition", async () => {
    await bake();
    for (const def of Object.values(DEFS)) {
      expect(Object.keys(manifest)).toContain(def.$$id);
    }
  });

  it("served from the build, each segment shows the links it shows live", async () => {
    const built = linkLines(await serve("/acme/web/core/code"));
    const issues = linkLines(await serve("/acme/web/issues"));
    expect([...new Set([...built, ...issues])].sort()).toEqual(devLines);
  });
});
