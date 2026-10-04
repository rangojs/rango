/**
 * Membership and hashing of the per-router cache versions, on hand-built
 * bundle graphs (the real-build counterpart is cache-versions-build.test.ts).
 *
 * The graph below is a host app with two lazily mounted routers:
 *
 *   entry ──(dynamic)──> a/handler ──> a/router ──> a/urls ──> shared, a/Button*
 *         ──(dynamic)──> b/handler ──> b/router ──────────────> shared
 *   runtime ──> server-references registry ──(dynamic)──> a/actions, a/orphan
 *
 * `*` is a "use client" module: a leaf in the server graph, and in the client
 * graph the importer of a/actions (a server action only client code imports).
 */
import { describe, expect, it } from "vitest";
import {
  classifyExternal,
  computeRouterVersions,
  digestBundle,
  ENCRYPTION_KEY_FILE,
  fillRouterVersions,
  portableModuleId,
  recordBundleFiles,
  recordClientGraph,
  recordServerGraph,
  recordVersionModuleFiles,
  resolveRouterMembers,
  stripRegionPaths,
  stripServerReferenceMap,
  type BuildDataRecord,
  type BuildModuleEdges,
  type BundleFiles,
  type ClientBuildGraph,
  type ComputeRouterVersionsInput,
  type ExternalResolver,
  type ServerBuildGraph,
} from "../discovery/build-versions.js";
import { ROUTER_VERSIONS_PLACEHOLDER } from "../plugins/virtual-entries.js";

const ROOT = "/project";
const SERVER_REFERENCES = "\0virtual:vite-rsc/server-references";
const LOADER_MANIFEST = "\0virtual:rsc-router/loader-manifest";
const ROUTES_MANIFEST = "\0virtual:rsc-router/routes-manifest";
const VERSION_MODULE = "\0@rangojs/router:version";

const edges = (
  imports: string[] = [],
  dynamicImports: string[] = [],
): BuildModuleEdges => ({ imports, dynamicImports });

const src = (file: string) => `${ROOT}/src/${file}`;

function serverGraph(): ServerBuildGraph {
  return {
    modules: new Map<string, BuildModuleEdges>([
      [
        src("host.ts"),
        edges(
          [ROUTES_MANIFEST, LOADER_MANIFEST],
          [src("a/handler.ts"), src("b/handler.ts")],
        ),
      ],
      [
        ROUTES_MANIFEST,
        edges(
          [],
          [`${ROUTES_MANIFEST}/router-a`, `${ROUTES_MANIFEST}/router-b`],
        ),
      ],
      [`${ROUTES_MANIFEST}/router-a`, edges()],
      [`${ROUTES_MANIFEST}/router-b`, edges()],
      [LOADER_MANIFEST, edges([], [src("a/loader.ts")])],
      [src("a/handler.ts"), edges([src("a/router.ts")])],
      [src("a/router.ts"), edges([src("a/urls.tsx"), src("runtime.ts")])],
      [
        src("a/urls.tsx"),
        edges([src("shared.ts"), src("a/Button.tsx")], [src("a/lazy.tsx")]),
      ],
      [src("a/lazy.tsx"), edges()],
      [src("a/Button.tsx"), edges()],
      [src("a/actions.ts"), edges([src("a/db.ts")])],
      [src("a/db.ts"), edges()],
      [src("a/loader.ts"), edges()],
      [src("orphan-action.ts"), edges()],
      [src("b/handler.ts"), edges([src("b/router.ts")])],
      [src("b/router.ts"), edges([src("shared.ts"), src("runtime.ts")])],
      [src("shared.ts"), edges()],
      [src("runtime.ts"), edges([SERVER_REFERENCES, VERSION_MODULE])],
      [
        SERVER_REFERENCES,
        edges([], [src("a/actions.ts"), src("orphan-action.ts")]),
      ],
      [VERSION_MODULE, edges()],
    ]),
    chunks: [
      {
        fileName: "index.js",
        name: "index",
        moduleIds: [src("host.ts"), ROUTES_MANIFEST, LOADER_MANIFEST],
      },
      {
        fileName: "assets/handler-AAAAAAAA.js",
        name: "handler",
        moduleIds: [
          src("a/handler.ts"),
          src("a/router.ts"),
          src("a/urls.tsx"),
          src("a/Button.tsx"),
        ],
      },
      {
        fileName: "assets/lazy-LLLLLLLL.js",
        name: "lazy",
        moduleIds: [src("a/lazy.tsx")],
      },
      {
        fileName: "assets/actions-CCCCCCCC.js",
        name: "actions",
        moduleIds: [src("a/actions.ts"), src("a/db.ts")],
      },
      {
        fileName: "assets/loader-DDDDDDDD.js",
        name: "loader",
        moduleIds: [src("a/loader.ts")],
      },
      {
        fileName: "assets/orphan-action-OOOOOOOO.js",
        name: "orphan-action",
        moduleIds: [src("orphan-action.ts")],
      },
      {
        fileName: "assets/handler-BBBBBBBB.js",
        name: "handler",
        moduleIds: [src("b/handler.ts"), src("b/router.ts")],
      },
      {
        fileName: "assets/shared-SSSSSSSS.js",
        name: "shared",
        moduleIds: [src("shared.ts")],
      },
      {
        fileName: "assets/runtime-RRRRRRRR.js",
        name: "runtime",
        moduleIds: [src("runtime.ts"), SERVER_REFERENCES, VERSION_MODULE],
      },
      {
        fileName: "assets/router-a-MMMMMMMM.js",
        name: "router-a",
        moduleIds: [`${ROUTES_MANIFEST}/router-a`],
      },
      {
        fileName: "assets/router-b-NNNNNNNN.js",
        name: "router-b",
        moduleIds: [`${ROUTES_MANIFEST}/router-b`],
      },
    ],
    assets: [],
  };
}

function clientGraph(): ClientBuildGraph {
  return {
    modules: new Map<string, BuildModuleEdges>([
      // The client component imports the action (a reference proxy here).
      [src("a/Button.tsx"), edges([src("a/actions.ts")])],
      [src("a/actions.ts"), edges()],
    ]),
    fileNames: ["assets/index-11111111.js"],
  };
}

const ROUTERS = [
  { id: "router-a", moduleId: src("a/router.ts") },
  { id: "router-b", moduleId: src("b/router.ts") },
];

/** File contents; references use the hashed names of the graph above. */
function serverFiles(): Record<string, string> {
  return {
    "index.js": `host(); import("./assets/handler-AAAAAAAA.js"); import("./assets/handler-BBBBBBBB.js");`,
    "assets/handler-AAAAAAAA.js": `import "./shared-SSSSSSSS.js"; import "./runtime-RRRRRRRR.js"; a(); import("./lazy-LLLLLLLL.js");`,
    "assets/lazy-LLLLLLLL.js": `lazyA();`,
    "assets/actions-CCCCCCCC.js": `actionA();`,
    "assets/loader-DDDDDDDD.js": `loaderA();`,
    "assets/orphan-action-OOOOOOOO.js": `orphan();`,
    "assets/handler-BBBBBBBB.js": `import "./shared-SSSSSSSS.js"; import "./runtime-RRRRRRRR.js"; b();`,
    "assets/shared-SSSSSSSS.js": `shared();`,
    "assets/runtime-RRRRRRRR.js": `runtime();\n//#region \\0virtual:vite-rsc/server-references\nvar refs = { "id-a": () => import("./actions-CCCCCCCC.js") };\n//#endregion\nvar ROUTER_VERSIONS = ${ROUTER_VERSIONS_PLACEHOLDER};`,
    "assets/router-a-MMMMMMMM.js": `trieA();`,
    "assets/router-b-NNNNNNNN.js": `trieB();`,
  };
}

const ASSETS_MANIFEST = "__vite_rsc_assets_manifest.js";

/** The SSR bundle: its entry, a chunk the entry imports, plugin-rsc's manifest. */
function ssrBundle(root = ROOT): BundleFiles {
  return {
    chunks: [
      {
        fileName: "index.js",
        name: "index",
        moduleIds: [`${root}/src/entry.ssr.tsx`],
      },
      {
        fileName: "assets/html-TTTTTTTT.js",
        name: "html",
        moduleIds: [`${root}/src/html.tsx`],
      },
    ],
    assets: [{ fileName: ASSETS_MANIFEST, name: ASSETS_MANIFEST }],
  };
}

function ssrFiles(): Record<string, string> {
  return {
    "index.js": `import "./assets/html-TTTTTTTT.js"; renderHtml();`,
    "assets/html-TTTTTTTT.js": `html();`,
    [ASSETS_MANIFEST]: `export default { clientEntryUrl: "/assets/index-11111111.js" };`,
  };
}

/** Nothing is installed and no path resolves, unless a test says so. */
const EXTERNALS: ExternalResolver = {
  describePackage: () => undefined,
  readFile: () => undefined,
  buildId: "build-1",
};

function compute(
  overrides: Partial<ComputeRouterVersionsInput> & {
    files?: Record<string, string>;
    ssrSources?: Record<string, string>;
  } = {},
) {
  const {
    files = serverFiles(),
    ssrSources = ssrFiles(),
    ...input
  } = overrides;
  const encoder = new TextEncoder();
  const reader =
    (sources: Record<string, string>) =>
    (fileName: string): Uint8Array | undefined =>
      fileName in sources ? encoder.encode(sources[fileName]) : undefined;
  return computeRouterVersions({
    projectRoot: ROOT,
    server: serverGraph(),
    client: clientGraph(),
    ssr: ssrBundle(),
    routers: ROUTERS,
    buildData: [],
    readServerFile: reader(files),
    readSsrFile: reader(ssrSources),
    base: "/",
    externals: EXTERNALS,
    ...input,
  });
}

const detailOf = (computed: ReturnType<typeof compute>, routerId: string) =>
  computed.details.find((detail) => detail.routerId === routerId)!;

/** Rename a chunk the way a content change does: new hash, new references. */
function withRenamedChunk(
  files: Record<string, string>,
  from: string,
  to: string,
  content?: string,
): Record<string, string> {
  const next: Record<string, string> = {};
  const base = (name: string) => name.slice(name.lastIndexOf("/") + 1);
  for (const [name, source] of Object.entries(files)) {
    const renamed = name === from ? to : name;
    const body = name === from && content !== undefined ? content : source;
    next[renamed] = body.split(base(from)).join(base(to));
  }
  return next;
}

function graphWithRenamedChunk(from: string, to: string): ServerBuildGraph {
  const graph = serverGraph();
  return {
    ...graph,
    chunks: graph.chunks.map((chunk) =>
      chunk.fileName === from ? { ...chunk, fileName: to } : chunk,
    ),
  };
}

describe("resolveRouterMembers", () => {
  const members = () =>
    resolveRouterMembers(serverGraph(), clientGraph(), ROUTERS);

  it("follows a router's static and dynamic imports", () => {
    const a = members().get("router-a")!;
    expect(a.modules.has(src("a/urls.tsx"))).toBe(true);
    expect(a.modules.has(src("a/lazy.tsx"))).toBe(true);
    expect(a.chunkFiles.has("assets/lazy-LLLLLLLL.js")).toBe(true);
    expect(a.chunkFiles.has("assets/shared-SSSSSSSS.js")).toBe(true);
  });

  it("adds the router's own route manifest chunk, which nothing it imports reaches", () => {
    const all = members();
    expect(
      all.get("router-a")!.chunkFiles.has("assets/router-a-MMMMMMMM.js"),
    ).toBe(true);
    expect(
      all.get("router-a")!.chunkFiles.has("assets/router-b-NNNNNNNN.js"),
    ).toBe(false);
    expect(
      all.get("router-b")!.chunkFiles.has("assets/router-b-NNNNNNNN.js"),
    ).toBe(true);
  });

  it("stops at the server-reference registry: one app's actions are not another's", () => {
    const b = members().get("router-b")!;
    // The registry's own chunk is shared runtime...
    expect(b.chunkFiles.has("assets/runtime-RRRRRRRR.js")).toBe(true);
    // ...but what it lists is not followed.
    expect(b.modules.has(src("a/actions.ts"))).toBe(false);
    expect(b.chunkFiles.has("assets/actions-CCCCCCCC.js")).toBe(false);
  });

  it("gives an action only a client component imports to the router that renders the component", () => {
    const a = members().get("router-a")!;
    expect(a.modules.has(src("a/actions.ts"))).toBe(true);
    // ...with the action's own imports.
    expect(a.modules.has(src("a/db.ts"))).toBe(true);
    expect(a.chunkFiles.has("assets/actions-CCCCCCCC.js")).toBe(true);
  });

  it("gives that action to every router when there is no client graph to attribute it through", () => {
    const withoutClient = resolveRouterMembers(
      serverGraph(),
      undefined,
      ROUTERS,
    );
    // No router reaches it, so it is every router's (next test).
    expect(
      withoutClient.get("router-a")!.modules.has(src("a/actions.ts")),
    ).toBe(true);
    expect(
      withoutClient.get("router-b")!.modules.has(src("a/actions.ts")),
    ).toBe(true);
  });

  it("gives a registry target no router reaches to every router", () => {
    const all = members();
    for (const id of ["router-a", "router-b"]) {
      expect(all.get(id)!.modules.has(src("orphan-action.ts"))).toBe(true);
      expect(all.get(id)!.modules.has(src("a/loader.ts"))).toBe(true);
      expect(
        all.get(id)!.chunkFiles.has("assets/orphan-action-OOOOOOOO.js"),
      ).toBe(true);
    }
  });

  it("keeps the host entry out of a lazily mounted router", () => {
    for (const member of members().values()) {
      expect(member.chunkFiles.has("index.js")).toBe(false);
    }
  });

  // Regression: the walk started at the createRouter() module only, so code
  // only an importer of the router reaches (the mounted handler's own
  // imports, middleware attached elsewhere) was in no router's version.
  it("covers what the modules that statically import the router run", () => {
    const graph = serverGraph();
    const modules = new Map(graph.modules);
    modules.set(
      src("a/handler.ts"),
      edges([src("a/router.ts")], [src("a/wiring.ts")]),
    );
    modules.set(src("a/wiring.ts"), edges());
    const all = resolveRouterMembers(
      {
        ...graph,
        modules,
        chunks: [
          ...graph.chunks,
          {
            fileName: "assets/wiring-WWWWWWWW.js",
            name: "wiring",
            moduleIds: [src("a/wiring.ts")],
          },
        ],
      },
      clientGraph(),
      ROUTERS,
    );
    expect(all.get("router-a")!.modules.has(src("a/handler.ts"))).toBe(true);
    expect(
      all.get("router-a")!.chunkFiles.has("assets/wiring-WWWWWWWW.js"),
    ).toBe(true);
    expect(all.get("router-b")!.modules.has(src("a/wiring.ts"))).toBe(false);
  });

  it("gives routers that one module imports statically that module's code", () => {
    const graph = serverGraph();
    const modules = new Map(graph.modules);
    // Not lazily mounted: the entry imports both handlers.
    modules.set(
      src("host.ts"),
      edges([
        ROUTES_MANIFEST,
        LOADER_MANIFEST,
        src("a/handler.ts"),
        src("b/handler.ts"),
      ]),
    );
    const all = resolveRouterMembers({ ...graph, modules }, clientGraph(), [
      ...ROUTERS,
    ]);
    for (const id of ["router-a", "router-b"]) {
      expect(all.get(id)!.chunkFiles.has("index.js")).toBe(true);
      expect(all.get(id)!.modules.has(src("a/urls.tsx"))).toBe(true);
    }
  });

  it("leaves out a router whose module the build does not have", () => {
    const all = resolveRouterMembers(serverGraph(), clientGraph(), [
      ...ROUTERS,
      { id: "ghost", moduleId: src("ghost/router.ts") },
      { id: "no-source", moduleId: undefined },
    ]);
    expect([...all.keys()]).toEqual(["router-a", "router-b"]);
  });

  it("finds a router module whose bundler id carries a query", () => {
    const graph = serverGraph();
    const modules = new Map(graph.modules);
    modules.set(`${src("c/router.ts")}?v=1`, edges([src("shared.ts")]));
    const all = resolveRouterMembers({ ...graph, modules }, undefined, [
      { id: "router-c", moduleId: src("c/router.ts") },
    ]);
    expect(all.get("router-c")!.modules.has(src("shared.ts"))).toBe(true);
  });
});

describe("computeRouterVersions", () => {
  it("returns a data and a document version per router and for the whole build", () => {
    const { table, details } = compute();
    expect(Object.keys(table)).toEqual(["router-a", "router-b", "*"]);
    for (const [data, document] of Object.values(table)) {
      expect(data).toMatch(/^[0-9a-f]{16}$/);
      expect(document).toMatch(/^[0-9a-f]{16}$/);
      expect(data).not.toBe(document);
    }
    expect(new Set(Object.values(table).flat()).size).toBe(6);
    expect(details.map((detail) => detail.routerId)).toEqual([
      "router-a",
      "router-b",
      "*",
    ]);
  });

  it("is deterministic", () => {
    expect(compute().table).toEqual(compute().table);
  });

  it("does not depend on the project directory", () => {
    const moved = (value: string) =>
      value.replaceAll(ROOT, "/elsewhere/checkout");
    const graph = serverGraph();
    const movedGraph: ServerBuildGraph = {
      ...graph,
      modules: new Map(
        [...graph.modules].map(([id, edge]) => [
          moved(id),
          edges(edge.imports.map(moved), edge.dynamicImports.map(moved)),
        ]),
      ),
      chunks: graph.chunks.map((chunk) => ({
        ...chunk,
        moduleIds: chunk.moduleIds.map(moved),
      })),
    };
    const there = compute({
      projectRoot: "/elsewhere/checkout",
      server: movedGraph,
      ssr: ssrBundle("/elsewhere/checkout"),
      client: {
        modules: new Map(
          [...clientGraph().modules].map(([id, edge]) => [
            moved(id),
            edges(edge.imports.map(moved)),
          ]),
        ),
        fileNames: clientGraph().fileNames,
      },
      routers: ROUTERS.map((router) => ({
        ...router,
        moduleId: moved(router.moduleId),
      })),
    });
    expect(there.table).toEqual(compute().table);
  });

  it("changes only the owner when a chunk one router owns changes", () => {
    const before = compute().table;
    const after = compute({
      server: graphWithRenamedChunk(
        "assets/handler-AAAAAAAA.js",
        "assets/handler-ZZZZZZZZ.js",
      ),
      files: withRenamedChunk(
        serverFiles(),
        "assets/handler-AAAAAAAA.js",
        "assets/handler-ZZZZZZZZ.js",
        `import "./shared-SSSSSSSS.js"; import "./runtime-RRRRRRRR.js"; aChanged(); import("./lazy-LLLLLLLL.js");`,
      ),
    }).table;
    expect(after["router-a"]![0]).not.toBe(before["router-a"]![0]);
    expect(after["router-b"]).toEqual(before["router-b"]);
    // The whole-build pair covers every file.
    expect(after["*"]![0]).not.toBe(before["*"]![0]);
  });

  it("is not moved by the new file name of a chunk the router does not own", () => {
    // Router B's runtime chunk names app A's action chunk in the reference
    // map; only that chunk's content hash changes here.
    const before = compute().table;
    const after = compute({
      server: graphWithRenamedChunk(
        "assets/actions-CCCCCCCC.js",
        "assets/actions-YYYYYYYY.js",
      ),
      files: withRenamedChunk(
        serverFiles(),
        "assets/actions-CCCCCCCC.js",
        "assets/actions-YYYYYYYY.js",
        `actionAChanged();`,
      ),
    }).table;
    expect(after["router-b"]).toEqual(before["router-b"]);
    expect(after["router-a"]![0]).not.toBe(before["router-a"]![0]);
  });

  it("changes every router that shares a changed chunk", () => {
    const before = compute().table;
    const after = compute({
      server: graphWithRenamedChunk(
        "assets/shared-SSSSSSSS.js",
        "assets/shared-XXXXXXXX.js",
      ),
      files: withRenamedChunk(
        serverFiles(),
        "assets/shared-SSSSSSSS.js",
        "assets/shared-XXXXXXXX.js",
        `sharedChanged();`,
      ),
    }).table;
    expect(after["router-a"]![0]).not.toBe(before["router-a"]![0]);
    expect(after["router-b"]![0]).not.toBe(before["router-b"]![0]);
  });

  it("does not hash the server-reference map itself", () => {
    const before = compute().table;
    const files = serverFiles();
    files["assets/runtime-RRRRRRRR.js"] = files[
      "assets/runtime-RRRRRRRR.js"
    ]!.replace(
      `var refs = { "id-a": () => import("./actions-CCCCCCCC.js") };`,
      `var refs = { "id-a": () => import("./actions-CCCCCCCC.js"), "id-new": () => import("./actions-CCCCCCCC.js") };`,
    );
    expect(compute({ files }).table).toEqual(before);
  });

  it("hashes the code around the server-reference map", () => {
    const before = compute().table;
    const files = serverFiles();
    files["assets/runtime-RRRRRRRR.js"] = files[
      "assets/runtime-RRRRRRRR.js"
    ]!.replace("runtime();", "runtimeChanged();");
    const after = compute({ files }).table;
    expect(after["router-a"]![0]).not.toBe(before["router-a"]![0]);
    expect(after["router-b"]![0]).not.toBe(before["router-b"]![0]);
  });

  it("tells apart two same-named chunks a router owns", () => {
    // Without an identity per chunk, swapping which of two `handler` chunks a
    // file imports would leave the normalized bytes identical.
    const graph = serverGraph();
    const routers = [{ id: "host", moduleId: src("host.ts") }];
    const files = serverFiles();
    const swapped = {
      ...files,
      "index.js": `host(); import("./assets/handler-BBBBBBBB.js"); import("./assets/handler-AAAAAAAA.js");`,
    };
    expect(
      compute({ server: graph, routers, files: swapped }).table.host![0],
    ).not.toBe(compute({ server: graph, routers, files }).table.host![0]);
  });

  it("uses the whole-build pair for everything, including the entry", () => {
    const before = compute().table;
    const files = serverFiles();
    files["index.js"] = files["index.js"]!.replace("host();", "hostChanged();");
    const after = compute({ files }).table;
    expect(after["router-a"]).toEqual(before["router-a"]);
    expect(after["router-b"]).toEqual(before["router-b"]);
    expect(after["*"]![0]).not.toBe(before["*"]![0]);
  });

  describe("what stored HTML depends on besides the server code", () => {
    const documentOnly = (after: ReturnType<typeof compute>): void => {
      const before = compute().table;
      for (const id of ["router-a", "router-b", "*"]) {
        expect(after.table[id]![0]).toBe(before[id]![0]);
        expect(after.table[id]![1]).not.toBe(before[id]![1]);
      }
    };

    it("puts the SSR output in every document version and in no data version", () => {
      documentOnly(
        compute({
          ssrSources: { ...ssrFiles(), "assets/html-TTTTTTTT.js": `html2();` },
        }),
      );
    });

    it("puts the client asset names and the base there too", () => {
      documentOnly(
        compute({
          client: { ...clientGraph(), fileNames: ["assets/index-22222222.js"] },
        }),
      );
      documentOnly(compute({ base: "/app/" }));
    });

    // The SSR output goes through digestBundle like the RSC output: an SSR
    // chunk's name is a content hash of bytes that include region comments.
    it("is not moved by an SSR chunk's file name or by its region comments", () => {
      const renamed: BundleFiles = {
        ...ssrBundle(),
        chunks: ssrBundle().chunks.map((chunk) =>
          chunk.name === "html"
            ? { ...chunk, fileName: "assets/html-UUUUUUUU.js" }
            : chunk,
        ),
      };
      expect(
        compute({
          ssr: renamed,
          ssrSources: {
            "index.js": `import "./assets/html-UUUUUUUU.js"; renderHtml();`,
            "assets/html-UUUUUUUU.js": `//#region apps/web/src/html.tsx\nhtml();`,
            [ASSETS_MANIFEST]: ssrFiles()[ASSETS_MANIFEST]!,
          },
        }).table,
      ).toEqual(
        compute({
          ssrSources: {
            ...ssrFiles(),
            "assets/html-TTTTTTTT.js": `//#region src/html.tsx\nhtml();`,
          },
        }).table,
      );
    });

    it("covers what the SSR output leaves external", () => {
      const ssr: BundleFiles = {
        ...ssrBundle(),
        chunks: ssrBundle().chunks.map((chunk) => ({
          ...chunk,
          externalImports: ["react-dom", "node:stream"],
        })),
      };
      const at = (version: string) =>
        compute({
          ssr,
          externals: {
            ...EXTERNALS,
            describePackage: (name) => `${name}@${version}`,
          },
        });
      const before = at("19.3.0").table;
      const after = at("19.3.1").table;
      for (const id of ["router-a", "router-b", "*"]) {
        expect(after[id]![0]).toBe(before[id]![0]);
        expect(after[id]![1]).not.toBe(before[id]![1]);
      }
    });
  });

  // A file the bundle lists and the output directory does not have would drop
  // out of every version without a word.
  it("throws when a listed RSC or SSR file is not on disk", () => {
    const { "assets/shared-SSSSSSSS.js": _shared, ...withoutShared } =
      serverFiles();
    expect(() => compute({ files: withoutShared })).toThrow(
      "the RSC bundle lists assets/shared-SSSSSSSS.js, which is not in its output directory",
    );
    const { [ASSETS_MANIFEST]: _manifest, ...withoutManifest } = ssrFiles();
    expect(() => compute({ ssrSources: withoutManifest })).toThrow(
      `the SSR bundle lists ${ASSETS_MANIFEST}, which is not in its output directory`,
    );
  });

  // The host entry of lazily mounted apps: in the whole-build pair only.
  it("names the server files no router owns", () => {
    const { unownedFiles } = compute();
    expect(unownedFiles).toHaveLength(1);
    expect(unownedFiles[0]).toMatch(/^index~[0-9a-f]{8}\.js$/);
  });

  describe("build-rendered payloads", () => {
    const prerender = (digest: string): BuildDataRecord => ({
      kind: "prerender",
      key: "blog.post/abc",
      digest,
      routerId: "router-a",
    });
    const staticRecord = (digest: string): BuildDataRecord => ({
      kind: "static",
      key: "h1#Sidebar",
      digest,
      moduleId: src("a/urls.tsx"),
    });

    it("puts a Prerender payload in its router's document version only", () => {
      const before = compute({ buildData: [prerender("p1")] }).table;
      const after = compute({ buildData: [prerender("p2")] }).table;
      expect(after["router-a"]![0]).toBe(before["router-a"]![0]);
      expect(after["router-a"]![1]).not.toBe(before["router-a"]![1]);
      expect(after["router-b"]).toEqual(before["router-b"]);
    });

    it("puts a Static payload in the data version of the routers that can run its handler", () => {
      const before = compute({ buildData: [staticRecord("s1")] }).table;
      const after = compute({ buildData: [staticRecord("s2")] }).table;
      expect(after["router-a"]![0]).not.toBe(before["router-a"]![0]);
      expect(after["router-b"]).toEqual(before["router-b"]);
    });

    it("gives a Static payload no router can be shown to run to every router", () => {
      const unowned = (digest: string): BuildDataRecord => ({
        kind: "static",
        key: "h2#Footer",
        digest,
        moduleId: src("not-in-the-graph.tsx"),
      });
      const before = compute({ buildData: [unowned("s1")] }).table;
      const after = compute({ buildData: [unowned("s2")] }).table;
      expect(after["router-a"]![0]).not.toBe(before["router-a"]![0]);
      expect(after["router-b"]![0]).not.toBe(before["router-b"]![0]);
    });

    // The server materializes a clientUrls() group from a projection of the
    // "use client" module. It ships in the routes registry, not in the app's
    // chunks, and the client module is a leaf the app's router reaches.
    it("puts a clientUrls() projection in the data version of the routers that include the module", () => {
      const projection = (digest: string): BuildDataRecord => ({
        kind: "client-urls",
        key: "src/a/Button.tsx",
        digest,
        moduleId: src("a/Button.tsx"),
      });
      const before = compute({ buildData: [projection("c1")] });
      const after = compute({ buildData: [projection("c2")] });
      expect(after.table["router-a"]![0]).not.toBe(
        before.table["router-a"]![0],
      );
      expect(after.table["router-b"]).toEqual(before.table["router-b"]);
      expect(before.details[0]!.dataInputs.map(([name]) => name)).toContain(
        "client-urls src/a/Button.tsx",
      );
    });

    it("gives two same-named inputs one order, whatever order they came in", () => {
      const twice = [staticRecord("s1"), staticRecord("s2")];
      expect(compute({ buildData: twice }).table).toEqual(
        compute({ buildData: [...twice].reverse() }).table,
      );
    });

    it("does not depend on the order payloads were rendered in", () => {
      const data = [prerender("p1"), staticRecord("s1")];
      expect(compute({ buildData: data }).table).toEqual(
        compute({ buildData: [...data].reverse() }).table,
      );
    });
  });

  describe("encryption key", () => {
    function keyedGraph(): ServerBuildGraph {
      const graph = serverGraph();
      const modules = new Map(graph.modules);
      // Only app A encrypts: its action module closes over a value.
      modules.set(src("a/actions.ts"), {
        ...edges([src("a/db.ts")]),
        encryptsBoundArgs: true,
      });
      return { ...graph, modules };
    }
    const filesWithKey = (key: string) => ({
      ...serverFiles(),
      [ENCRYPTION_KEY_FILE]: `export default ${JSON.stringify(key)};\n`,
    });
    const usesKey = (computed: ReturnType<typeof compute>) =>
      Object.fromEntries(
        computed.details.map((detail) => [
          detail.routerId,
          detail.usesEncryptionKey,
        ]),
      );

    it("is part of the version of a router whose code encrypts with it, and of no other", () => {
      const before = compute({
        server: keyedGraph(),
        files: filesWithKey("key-1"),
      });
      const after = compute({
        server: keyedGraph(),
        files: filesWithKey("key-2"),
      });
      expect(after.table["router-a"]![0]).not.toBe(
        before.table["router-a"]![0],
      );
      expect(after.table["router-b"]).toEqual(before.table["router-b"]);
      expect(after.table["*"]![0]).not.toBe(before.table["*"]![0]);
      expect(usesKey(before)).toEqual({
        "router-a": true,
        "router-b": false,
        "*": true,
      });
    });

    it("is in no version of a build that does not encrypt", () => {
      const computed = compute();
      expect(usesKey(computed)).toEqual({
        "router-a": false,
        "router-b": false,
        "*": false,
      });
      expect(
        detailOf(computed, "*").dataInputs.map(([name]) => name),
      ).not.toContain("encryption-key");
    });

    // plugin-rsc writes the key file only when a chunk reads the key. A file
    // with no module recognised as encrypting means the recognition failed (a
    // rename in plugin-rsc): leaving the key out would serve cached payloads
    // the next key cannot decrypt.
    it("is every router's when the key file exists and no module is recognised as using it", () => {
      const before = compute({ files: filesWithKey("key-1") });
      const after = compute({ files: filesWithKey("key-2") });
      for (const id of ["router-a", "router-b", "*"]) {
        expect(after.table[id]![0]).not.toBe(before.table[id]![0]);
      }
      expect(usesKey(before)).toEqual({
        "router-a": true,
        "router-b": true,
        "*": true,
      });
    });

    it("fails the build when code encrypts and the key file cannot be found", () => {
      expect(() => compute({ server: keyedGraph() })).toThrow(
        /1 server module\(s\) encrypt action arguments \(src\/a\/actions\.ts\), but __vite_rsc_encryption_key\.js is not in the RSC output directory/,
      );
    });
  });

  describe("what the bundle leaves external", () => {
    // Router B's chunk imports a package and a subpath of a scoped one; what
    // is installed for them is not in any chunk.
    function graphWithExternals(specifiers: string[]): ServerBuildGraph {
      const graph = serverGraph();
      return {
        ...graph,
        chunks: graph.chunks.map((chunk) =>
          chunk.fileName === "assets/handler-BBBBBBBB.js"
            ? { ...chunk, externalImports: specifiers }
            : chunk,
        ),
      };
    }
    const PACKAGES = [
      "marked",
      "@scope/db/client",
      "node:fs",
      "fs",
      "cloudflare:workers",
      "virtual:vite-rsc/assets-manifest",
    ];
    const installed =
      (versions: Record<string, string>) =>
      (name: string): string | undefined =>
        name in versions ? `${name}@${versions[name]}` : undefined;
    const externalNames = (computed: ReturnType<typeof compute>, id: string) =>
      detailOf(computed, id)
        .dataInputs.map(([name]) => name)
        .filter((name) => name.startsWith("external "));

    it("puts what is installed in the data version of the routers importing it", () => {
      const at = (marked: string) =>
        compute({
          server: graphWithExternals(PACKAGES),
          externals: {
            ...EXTERNALS,
            describePackage: installed({ marked, "@scope/db": "2.0.0" }),
          },
        });
      const before = at("1.0.0");
      const after = at("1.0.1");
      expect(after.table["router-b"]![0]).not.toBe(
        before.table["router-b"]![0],
      );
      expect(after.table["router-a"]).toEqual(before.table["router-a"]);
      expect(after.table["*"]![0]).not.toBe(before.table["*"]![0]);
      expect(before.undetermined).toEqual([]);
    });

    it("names packages, not specifiers, and leaves out what the runtime provides", () => {
      expect(
        externalNames(
          compute({
            server: graphWithExternals(PACKAGES),
            externals: {
              ...EXTERNALS,
              describePackage: installed({
                marked: "1.0.0",
                "@scope/db": "2.0.0",
              }),
            },
          }),
          "router-b",
        ),
      ).toEqual(["external @scope/db", "external marked"]);
    });

    // Left out, a lockfile bump of that package would change what the server
    // renders and no version.
    it("gives a package that is not installed a value unique to the build, and names it", () => {
      const at = (buildId: string) =>
        compute({
          server: graphWithExternals(PACKAGES),
          externals: { ...EXTERNALS, buildId },
        });
      const first = at("build-1");
      const second = at("build-2");
      expect(second.table["router-b"]![0]).not.toBe(
        first.table["router-b"]![0],
      );
      expect(second.table["router-a"]).toEqual(first.table["router-a"]);
      expect(at("build-1").table).toEqual(first.table);
      expect(first.undetermined).toEqual(["@scope/db", "marked"]);
    });

    it("digests a file a chunk imports by path, relative to the chunk or absolute", () => {
      const at = (native: string, absolute: string) =>
        compute({
          server: graphWithExternals(["../native.node", "/project/lib/a.node"]),
          files: { ...serverFiles(), "native.node": native },
          externals: {
            ...EXTERNALS,
            readFile: (path) =>
              path === "/project/lib/a.node"
                ? new TextEncoder().encode(absolute)
                : undefined,
          },
        });
      const before = at("n1", "a1");
      expect(externalNames(before, "router-b")).toEqual([
        "external lib/a.node",
        "external native.node",
      ]);
      expect(before.undetermined).toEqual([]);
      expect(at("n2", "a1").table["router-b"]![0]).not.toBe(
        before.table["router-b"]![0],
      );
      expect(at("n1", "a2").table["router-b"]![0]).not.toBe(
        before.table["router-b"]![0],
      );
      expect(at("n1", "a1").table).toEqual(before.table);
    });

    it("names a file outside the project by its path, whatever the checkout's depth", () => {
      const names = (projectRoot: string) =>
        externalNames(
          compute({
            projectRoot,
            server: graphWithExternals(["/opt/lib/native.node"]),
            externals: {
              ...EXTERNALS,
              readFile: () => new TextEncoder().encode("bytes"),
            },
          }),
          "*",
        );
      expect(names(ROOT)).toEqual(["external /opt/lib/native.node"]);
      expect(names("/a/much/deeper/checkout")).toEqual(names(ROOT));
    });

    it("treats a path that does not resolve and a URL like a missing package", () => {
      const at = (buildId: string) =>
        compute({
          server: graphWithExternals([
            "./gone.node",
            "https://esm.sh/x",
            "_private",
          ]),
          externals: { ...EXTERNALS, buildId },
        });
      expect(at("build-1").undetermined).toEqual([
        "_private",
        "assets/gone.node",
        "https://esm.sh/x",
      ]);
      expect(at("build-2").table["router-b"]![0]).not.toBe(
        at("build-1").table["router-b"]![0],
      );
    });

    it("classifies a specifier", () => {
      const kind = (specifier: string) => classifyExternal(specifier);
      expect(kind("marked")).toEqual({ kind: "package", name: "marked" });
      expect(kind("marked/lib/x.js")).toEqual({
        kind: "package",
        name: "marked",
      });
      expect(kind("@scope/db/client")).toEqual({
        kind: "package",
        name: "@scope/db",
      });
      for (const provided of [
        "node:fs",
        "fs",
        "cloudflare:workers",
        "workerd:unsafe",
        "bun:sqlite",
        "data:text/javascript,export default 1",
        // plugin-rsc's manifest: covered entry by entry (server-css).
        "virtual:vite-rsc/assets-manifest",
        // @cloudflare/vite-plugin's marker for a module it emits as an asset.
        // Taken for a package, it is one nobody can find: 6 different
        // versions in 6 builds of the stress demo.
        "__CLOUDFLARE_MODULE__Text__/app/dist/rsc/manifest.txt__CLOUDFLARE_MODULE__",
      ]) {
        expect(kind(provided), provided).toEqual({ kind: "provided" });
      }
      for (const file of [
        "./local.js",
        "../x.node",
        "/abs/file.js",
        "C:\\x.node",
      ]) {
        expect(kind(file), file).toEqual({ kind: "file" });
      }
      for (const unknown of [
        "https://esm.sh/x",
        "npm:x@1",
        "virtual:other",
        "_private",
        "@scope/_private",
      ]) {
        expect(kind(unknown), unknown).toEqual({ kind: "unknown" });
      }
    });
  });

  describe("stylesheets of server components", () => {
    // plugin-rsc's serverResources: a/urls.tsx imports CSS, and so does a
    // module no router reaches.
    const resources = (href: string) =>
      new Map([
        ["src/a/urls.tsx", `{ "js": [], "css": ["${href}"] }`],
        ["src/unreached.tsx", `{ "js": [], "css": ["/assets/u-1.css"] }`],
      ]);
    /** plugin-rsc's module that renders the links of the entry keyed `file`. */
    const cssModule = (file: string) =>
      `\0virtual:vite-rsc/css?type=rsc&id=${encodeURIComponent(src(file))}&lang.js`;
    /** The graph with `importer` importing the CSS module of `keyed`. */
    function graphWithCss(importer: string, keyed: string): ServerBuildGraph {
      const graph = serverGraph();
      const modules = new Map(graph.modules);
      const own = modules.get(src(importer))!;
      modules.set(src(importer), {
        ...own,
        imports: [...own.imports, cssModule(keyed)],
      });
      modules.set(cssModule(keyed), edges());
      return { ...graph, modules };
    }
    const dataInputNames = (
      server: ServerBuildGraph,
      routerId: string,
    ): string[] =>
      compute({ server, serverResources: resources("/assets/a-AAAA.css") })
        .details.find((detail) => detail.routerId === routerId)!
        .dataInputs.map(([name]) => name)
        .filter((name) => name.startsWith("server-css "));

    it("puts a module's stylesheets in the data version of the routers that run it", () => {
      const server = graphWithCss("a/urls.tsx", "a/urls.tsx");
      const before = compute({
        server,
        serverResources: resources("/assets/a-AAAA.css"),
      });
      const after = compute({
        server,
        serverResources: resources("/assets/a-BBBB.css"),
      });
      expect(after.table["router-a"]![0]).not.toBe(
        before.table["router-a"]![0],
      );
      expect(after.table["router-b"]).toEqual(before.table["router-b"]);
      expect(after.table["*"]![0]).not.toBe(before.table["*"]![0]);
    });

    it("gives an entry whose module no router reaches to every router", () => {
      const server = graphWithCss("a/urls.tsx", "a/urls.tsx");
      expect(dataInputNames(server, "router-a")).toEqual([
        "server-css src/a/urls.tsx",
        "server-css src/unreached.tsx",
      ]);
      expect(dataInputNames(server, "router-b")).toEqual([
        "server-css src/unreached.tsx",
      ]);
    });

    // `import.meta.viteRsc.loadCss("./other")`: the caller renders the links
    // of an entry keyed by another module.
    it("follows the module that renders the links, not the one the entry is keyed by", () => {
      const server = graphWithCss("b/router.ts", "a/urls.tsx");
      expect(dataInputNames(server, "router-b")).toEqual([
        "server-css src/a/urls.tsx",
        "server-css src/unreached.tsx",
      ]);
      // Router A imports a/urls.tsx but nothing that renders its links.
      expect(dataInputNames(server, "router-a")).toEqual([
        "server-css src/unreached.tsx",
      ]);
    });
  });

  // The bundler prints a module's path above its code. The path says where the
  // build ran: relative to the directory vite was started from, through the
  // pnpm store directory with its peer suffix, or (a virtual id) with an
  // absolute path in its query.
  it("does not depend on the paths in a chunk's region comments", () => {
    const handler = (regions: [string, string, string]) => ({
      ...serverFiles(),
      "assets/handler-AAAAAAAA.js": [
        `//#region ${regions[0]}`,
        `import "./shared-SSSSSSSS.js"; import "./runtime-RRRRRRRR.js"; a();`,
        "//#endregion",
        `//#region ${regions[1]}`,
        "dep();",
        "//#endregion",
        `//#region ${regions[2]}`,
        `import("./lazy-LLLLLLLL.js");`,
        "//#endregion",
      ].join("\n"),
    });
    const css = (root: string) =>
      `\\0virtual:vite-rsc/css?type=rsc&id=${encodeURIComponent(`${root}/src/a/urls.tsx`)}&lang.js`;
    const fromTheApp = compute({
      files: handler([
        "src/a/handler.ts",
        "../../node_modules/.pnpm/dep@1.0.0_typescript@5.8.3/node_modules/dep/index.js",
        css("/home/ci/checkout"),
      ]),
    });
    const fromTheRepoRoot = compute({
      files: handler([
        "apps/web/src/a/handler.ts",
        "node_modules/.pnpm/dep@1.0.0_typescript@5.9.2/node_modules/dep/index.js",
        css("/Users/dev/project"),
      ]),
    });
    expect(fromTheRepoRoot.table).toEqual(fromTheApp.table);
  });

  it("still hashes the code under a region comment", () => {
    const withCode = (code: string) =>
      compute({
        files: {
          ...serverFiles(),
          "assets/handler-AAAAAAAA.js": `//#region src/a/handler.ts\n${code}\n//#endregion`,
        },
      }).table["router-a"]![0];
    expect(withCode("a2();")).not.toBe(withCode("a1();"));
  });

  it("adds a bundle asset a router's chunk names, as bytes", () => {
    const graph = serverGraph();
    const withAsset: ServerBuildGraph = {
      ...graph,
      assets: [
        { fileName: "assets/manifest-a-QQQQQQQQ.txt", name: "manifest-a.txt" },
        {
          fileName: "assets/router-a-MMMMMMMM.js.map",
          name: "router-a.js.map",
        },
      ],
    };
    const files = (trie: string) => ({
      ...serverFiles(),
      "assets/router-a-MMMMMMMM.js": `import t from "./manifest-a-QQQQQQQQ.txt"; trieA(t);`,
      "assets/manifest-a-QQQQQQQQ.txt": trie,
      "assets/router-a-MMMMMMMM.js.map": `{"mappings":"${trie}"}`,
    });
    const before = compute({ server: withAsset, files: files("{}") });
    const after = compute({ server: withAsset, files: files('{"r":1}') });
    expect(after.table["router-a"]![0]).not.toBe(before.table["router-a"]![0]);
    expect(after.table["router-b"]).toEqual(before.table["router-b"]);
    const names = before.details[0]!.dataInputs.map(([name]) => name);
    expect(names).toContain("file manifest-a.txt");
    // A sourcemap is not code the server runs.
    expect(names.some((name) => name.includes(".map"))).toBe(false);
  });

  it("lists what each version was computed from", () => {
    const computed = compute({
      buildData: [
        { kind: "prerender", key: "p/1", digest: "d", routerId: "router-b" },
      ],
    });
    const b = detailOf(computed, "router-b");
    expect(b.dataInputs.map(([name]) => name)).toEqual(
      [...b.dataInputs.map(([name]) => name)].sort(),
    );
    expect(b.dataInputs.every(([name]) => name.startsWith("file "))).toBe(true);
    expect(b.documentInputs).toEqual([
      ["prerender p/1", "d"],
      ["ssr-and-client", expect.stringMatching(/^[0-9a-f]{64}$/)],
    ]);
  });
});

describe("stripServerReferenceMap", () => {
  it("drops the map's body and keeps the region marker", () => {
    const source = [
      "before();",
      "//#region \\0virtual:vite-rsc/server-references",
      "var refs = { a: 1 };",
      "//#endregion",
      "after();",
    ].join("\n");
    expect(stripServerReferenceMap(source)).toBe(
      [
        "before();",
        "//#region \\0virtual:vite-rsc/server-references",
        "//#endregion",
        "after();",
      ].join("\n"),
    );
  });

  it("leaves a source without the region (a minified chunk) untouched", () => {
    const source = "var refs={a:1};after();";
    expect(stripServerReferenceMap(source)).toBe(source);
  });
});

describe("what the ssr-and-client input is a digest of", () => {
  it("lists the base, the SSR files, the SSR externals and the client names", () => {
    const { ssrAndClient } = compute();
    expect(ssrAndClient).toEqual({
      base: "/",
      ssr: [
        [ASSETS_MANIFEST, expect.stringMatching(/^[0-9a-f]{64}$/)],
        [
          expect.stringMatching(/^html~[0-9a-f]{8}\.js$/),
          expect.stringMatching(/^[0-9a-f]{64}$/),
        ],
        [
          expect.stringMatching(/^index~[0-9a-f]{8}\.js$/),
          expect.stringMatching(/^[0-9a-f]{64}$/),
        ],
      ],
      externals: [],
      client: ["assets/index-11111111.js"],
    });
  });

  it("is independent of the order files are listed in", () => {
    const client = {
      ...clientGraph(),
      fileNames: ["assets/b-22222222.js", "assets/a-11111111.js"],
    };
    const reversed = compute({
      client: { ...client, fileNames: [...client.fileNames].reverse() },
      ssr: { ...ssrBundle(), chunks: [...ssrBundle().chunks].reverse() },
    });
    expect(reversed.table).toEqual(compute({ client }).table);
  });
});

describe("version handoff", () => {
  it("finds the chunks of a bundle holding the version module", () => {
    expect(
      recordVersionModuleFiles({
        "index.js": {
          type: "chunk",
          fileName: "index.js",
          moduleIds: ["/src/entry.ts"],
        },
        "assets/runtime-RRRRRRRR.js": {
          type: "chunk",
          fileName: "assets/runtime-RRRRRRRR.js",
          moduleIds: ["/src/runtime.ts", VERSION_MODULE],
        },
        "assets/style-SSSSSSSS.css": {
          type: "asset",
          fileName: "assets/style-SSSSSSSS.css",
        },
      }),
    ).toEqual(["assets/runtime-RRRRRRRR.js"]);
  });

  it("replaces the placeholder with the table", () => {
    const table = { "router-a": ["d1", "h1"], "*": ["d", "h"] } as const;
    const filled = fillRouterVersions(
      `var ROUTER_VERSIONS = ${ROUTER_VERSIONS_PLACEHOLDER};\nvar VERSION = ROUTER_VERSIONS["*"][1];`,
      table,
    )!;
    expect(filled).not.toContain(ROUTER_VERSIONS_PLACEHOLDER);
    const evaluated = new Function(
      `${filled}\nreturn { ROUTER_VERSIONS, VERSION };`,
    )();
    expect(evaluated.ROUTER_VERSIONS).toEqual(table);
    expect(evaluated.VERSION).toBe("h");
  });

  it("reports a source that has no placeholder", () => {
    expect(
      fillRouterVersions("var x = 1;", { "*": ["d", "h"] }),
    ).toBeUndefined();
  });

  // Regression: a string replacement reads `$$` and `$'` in a consumer's
  // router id as patterns, writing another id or splicing the chunk into it.
  it("writes a router id holding `$` as it is", () => {
    const table = { shop$$eu: ["d1", "h1"], "a$'b": ["d2", "h2"] } as const;
    const filled = fillRouterVersions(
      `var ROUTER_VERSIONS = ${ROUTER_VERSIONS_PLACEHOLDER};\nvar after = 1;`,
      table,
    )!;
    expect(new Function(`${filled}\nreturn ROUTER_VERSIONS;`)()).toEqual(table);
  });
});

describe("portableModuleId", () => {
  it("is root-relative inside the project and package-relative under node_modules", () => {
    expect(portableModuleId("/project/src/a.ts", ROOT)).toBe("src/a.ts");
    expect(
      portableModuleId("/monorepo/packages/ui/b.ts", "/monorepo/app"),
    ).toBe("../packages/ui/b.ts");
    expect(
      portableModuleId(
        "/project/node_modules/.pnpm/x@1/node_modules/x/i.js",
        ROOT,
      ),
    ).toBe("node_modules/.pnpm/x@1/node_modules/x/i.js");
    // A hoisted install above the project root gives the same id.
    expect(
      portableModuleId(
        "/monorepo/node_modules/.pnpm/x@1/node_modules/x/i.js",
        "/monorepo/apps/web",
      ),
    ).toBe("node_modules/.pnpm/x@1/node_modules/x/i.js");
    // Two installed versions of one package stay apart.
    expect(
      portableModuleId(
        "/project/node_modules/.pnpm/x@2/node_modules/x/i.js",
        ROOT,
      ),
    ).not.toBe(
      portableModuleId(
        "/project/node_modules/.pnpm/x@1/node_modules/x/i.js",
        ROOT,
      ),
    );
    expect(portableModuleId("\0virtual:thing", ROOT)).toBe("virtual:thing");
  });

  // pnpm names a store directory after the package AND what it was installed
  // against, peers of peers included. Bumping one of those (TypeScript is an
  // optional peer of many) renames the directory of a package whose own files
  // did not change, and with it the identity of every chunk holding its code.
  it("reduces a pnpm store directory to name@version", () => {
    const store = (dir: string) =>
      portableModuleId(
        `/project/node_modules/.pnpm/${dir}/node_modules/@vitejs/plugin-rsc/dist/rsc.js`,
        ROOT,
      );
    const reduced =
      "node_modules/.pnpm/@vitejs+plugin-rsc@0.5.35/node_modules/@vitejs/plugin-rsc/dist/rsc.js";
    expect(
      store(
        "@vitejs+plugin-rsc@0.5.35_react-dom@19.3.0_react@19.3.0__react@19.3.0_vite@8.0.16_@type_e0720fd81c074701e9e6cec54ec82ff5",
      ),
    ).toBe(reduced);
    expect(
      store("@vitejs+plugin-rsc@0.5.35_react@19.3.0_typescript@5.9.2"),
    ).toBe(reduced);
    expect(store("@vitejs+plugin-rsc@0.5.35")).toBe(reduced);
    // Another version of the package is another package.
    expect(store("@vitejs+plugin-rsc@0.5.36_react@19.3.0")).not.toBe(reduced);
    // An unscoped name, and a version with a prerelease tag.
    expect(
      portableModuleId(
        "/project/node_modules/.pnpm/react-dom@19.3.0-rc.1_react@19.3.0/node_modules/react-dom/server.js",
        ROOT,
      ),
    ).toBe(
      "node_modules/.pnpm/react-dom@19.3.0-rc.1/node_modules/react-dom/server.js",
    );
  });

  // plugin-rsc's group id for a chunk whose facade is a virtual module holds
  // the relative path from the root to the directory vite was started in.
  it("drops the working directory from a client-reference group of a virtual facade", () => {
    const group = (facade: string) =>
      portableModuleId(
        `\0virtual:vite-rsc/client-references/group/facade:${facade}`,
        ROOT,
      );
    const inTheApp = group("\0virtual:cloudflare/worker-entry");
    expect(group("__/__/\0virtual:cloudflare/worker-entry")).toBe(inTheApp);
    expect(group("__/other/\0virtual:cloudflare/worker-entry")).toBe(inTheApp);
    // A file facade is root-relative already and keeps its path.
    expect(group("src/pages/home.tsx")).toBe(
      "virtual:vite-rsc/client-references/group/facade:src/pages/home.tsx",
    );
    expect(group("__/ui/button.tsx")).not.toBe(group("ui/button.tsx"));
  });

  it("makes a file path in a virtual id's query portable", () => {
    const id = (root: string) =>
      `\0virtual:vite-rsc/css?type=rsc&id=${encodeURIComponent(`${root}/src/note.tsx`)}&lang.js`;
    expect(portableModuleId(id("/project"), "/project")).toBe(
      "virtual:vite-rsc/css?type=rsc&id=src/note.tsx&lang.js",
    );
    expect(portableModuleId(id("/other/dir"), "/other/dir")).toBe(
      portableModuleId(id("/project"), "/project"),
    );
  });
});

describe("stripRegionPaths", () => {
  it("takes the path out of every region comment and leaves the code", () => {
    const source = [
      `//#region \\0virtual:vite-rsc/css?type=rsc&id=${encodeURIComponent("/project/src/note.tsx")}&lang.js`,
      `var a = "/project/src/kept.ts";`,
      "//#endregion",
      "//#region ../../node_modules/.pnpm/x@1_y@2/node_modules/x/i.js",
      `var b = "//#region not at the start of a line";`,
      "//#endregion",
    ].join("\n");
    expect(stripRegionPaths(source)).toBe(
      [
        "//#region",
        `var a = "/project/src/kept.ts";`,
        "//#endregion",
        "//#region",
        `var b = "//#region not at the start of a line";`,
        "//#endregion",
      ].join("\n"),
    );
  });

  it("returns a source without regions (a minified chunk) as it is", () => {
    const source = "a();b();";
    expect(stripRegionPaths(source)).toBe(source);
  });
});

describe("digestBundle", () => {
  const bundle: BundleFiles = {
    chunks: [
      { fileName: "index.js", name: "index", moduleIds: ["/project/src/e.ts"] },
      {
        fileName: "assets/dep-AAAAAAAA.js",
        name: "dep",
        moduleIds: ["/project/src/dep.ts"],
        externalImports: ["marked"],
      },
    ],
    assets: [
      { fileName: "assets/data-BBBBBBBB.txt", name: "data.txt" },
      { fileName: "assets/dep-AAAAAAAA.js.map", name: "dep.js.map" },
    ],
  };
  const read =
    (files: Record<string, string>) =>
    (fileName: string): Uint8Array | undefined =>
      fileName in files ? new TextEncoder().encode(files[fileName]) : undefined;
  const files = {
    "index.js": `import "./assets/dep-AAAAAAAA.js"; import t from "./assets/data-BBBBBBBB.txt"; import "./assets/dep-AAAAAAAA.js";`,
    "assets/dep-AAAAAAAA.js": "dep();",
    "assets/data-BBBBBBBB.txt": "dep-AAAAAAAA.js is only text here",
  };

  it("digests each file once, with its references to hashed file names taken out and listed", () => {
    const digested = digestBundle(bundle, ROOT, read(files), "RSC");
    expect(digested.map((file) => file.fileName)).toEqual([
      "index.js",
      "assets/dep-AAAAAAAA.js",
      "assets/data-BBBBBBBB.txt",
    ]);
    const [index, dep, data] = digested;
    expect(index!.references).toEqual([
      "assets/dep-AAAAAAAA.js",
      "assets/data-BBBBBBBB.txt",
      "assets/dep-AAAAAAAA.js",
    ]);
    expect(dep!.identity).toMatch(/^dep~[0-9a-f]{8}\.js$/);
    expect(dep!.externalImports).toEqual(["marked"]);
    // An asset is data: hashed as bytes, never scanned.
    expect(data).toMatchObject({ identity: "data.txt", references: [] });

    // The same bundle under other content hashes digests the same.
    const renamed = digestBundle(
      {
        chunks: bundle.chunks.map((chunk) => ({
          ...chunk,
          fileName: chunk.fileName.replace("AAAAAAAA", "CCCCCCCC"),
        })),
        assets: [bundle.assets[0]!],
      },
      ROOT,
      read({
        "index.js": files["index.js"].replaceAll("AAAAAAAA", "CCCCCCCC"),
        "assets/dep-CCCCCCCC.js": "dep();",
        "assets/data-BBBBBBBB.txt": files["assets/data-BBBBBBBB.txt"],
      }),
      "RSC",
    );
    expect(renamed.map((file) => file.base)).toEqual(
      digested.map((file) => file.base),
    );
  });

  // The token standing for a file name is not text a chunk can hold: with a
  // printable one, moving a reference past the same character in the code
  // left the digest as it was.
  it("tells a file reference from the code around it", () => {
    const base = (index: string) =>
      digestBundle(
        bundle,
        ROOT,
        read({ ...files, "index.js": index }),
        "RSC",
      )[0]!.base;
    // The same text around the name in both, the name in another place.
    expect(base(`load("dep-AAAAAAAA.js", "~");`)).not.toBe(
      base(`load("~", "dep-AAAAAAAA.js");`),
    );
  });

  it("throws for a listed file the output directory does not have", () => {
    const { "assets/data-BBBBBBBB.txt": _data, ...missing } = files;
    expect(() => digestBundle(bundle, ROOT, read(missing), "SSR")).toThrow(
      "the SSR bundle lists assets/data-BBBBBBBB.txt, which is not in its output directory",
    );
  });
});

describe("graph recording", () => {
  const RUNTIME = "/n/@vitejs/plugin-rsc/dist/utils/encryption-runtime.js";
  const IMPORT = `import * as __vite_rsc_encryption_runtime from "${RUNTIME}";\n`;
  const code: Record<string, string | null> = {
    "/a.ts": `${IMPORT}registerServerReference(save).bind(null, __vite_rsc_encryption_runtime.encryptActionBoundArgs([id]))`,
    "/file-level-action.ts": `${IMPORT}registerServerReference(ping, "id", "ping")`,
    // plugin-rsc renamed the function it calls.
    "/renamed-call.ts": `${IMPORT}registerServerReference(save).bind(null, __vite_rsc_encryption_runtime.sealBoundArgs([id]))`,
    // plugin-rsc imports the runtime another way.
    "/other-import.ts": `import { sealBoundArgs } from "${RUNTIME}";\nregisterServerReference(ping, "id", "ping")`,
    "/no-code.ts": null,
  };
  const context = {
    getModuleIds: () => ["/a.ts", "/b.ts", ...Object.keys(code).slice(1)],
    getModuleInfo: (id: string) =>
      id === "/b.ts"
        ? null
        : {
            importedIds: id === "/a.ts" ? ["/b.ts", RUNTIME] : [RUNTIME],
            dynamicallyImportedIds: id === "/a.ts" ? ["/c.ts"] : [],
            get code() {
              return code[id];
            },
          },
  };
  const bundle = {
    "index.js": {
      type: "chunk",
      fileName: "index.js",
      name: "index",
      moduleIds: ["/a.ts"],
      imports: ["assets/dep-HASH.js", "marked", "node:fs"],
      dynamicImports: ["pg"],
    },
    "assets/dep-HASH.js": {
      type: "chunk",
      fileName: "assets/dep-HASH.js",
      name: "dep",
      moduleIds: ["/b.ts"],
    },
    "assets/m-HASH.txt": {
      type: "asset",
      fileName: "assets/m-HASH.txt",
      names: ["m.txt"],
    },
  };
  const FILES: BundleFiles = {
    chunks: [
      {
        fileName: "index.js",
        name: "index",
        moduleIds: ["/a.ts"],
        externalImports: ["marked", "node:fs", "pg"],
      },
      {
        fileName: "assets/dep-HASH.js",
        name: "dep",
        moduleIds: ["/b.ts"],
        externalImports: [],
      },
    ],
    assets: [{ fileName: "assets/m-HASH.txt", name: "m.txt" }],
  };

  it("records a bundle's chunks, with what each imports from outside it, and its assets", () => {
    expect(recordBundleFiles(bundle)).toEqual(FILES);
  });

  it("records the server graph: the modules and the bundle's files", () => {
    const graph = recordServerGraph(context, bundle);
    expect(graph.modules.get("/b.ts")).toEqual({
      imports: [],
      dynamicImports: [],
    });
    expect({ chunks: graph.chunks, assets: graph.assets }).toEqual(FILES);
  });

  // plugin-rsc imports its encryption runtime into every "use server" module;
  // only a module that uses it depends on the key.
  it("marks a module that uses the encryption runtime, not one that only imports it", () => {
    const { modules } = recordServerGraph(context, bundle);
    expect(modules.get("/a.ts")).toEqual({
      imports: ["/b.ts", RUNTIME],
      dynamicImports: ["/c.ts"],
      encryptsBoundArgs: true,
    });
    expect(modules.get("/file-level-action.ts")!.encryptsBoundArgs).toBe(
      undefined,
    );
  });

  // The key must not drop out of the versions because plugin-rsc renamed a
  // function or changed how it imports the runtime.
  it("does not depend on the name of the function plugin-rsc calls", () => {
    const { modules } = recordServerGraph(context, bundle);
    expect(modules.get("/renamed-call.ts")!.encryptsBoundArgs).toBe(true);
  });

  it("counts a module it cannot read as using the runtime", () => {
    const { modules } = recordServerGraph(context, bundle);
    expect(modules.get("/other-import.ts")!.encryptsBoundArgs).toBe(true);
    expect(modules.get("/no-code.ts")!.encryptsBoundArgs).toBe(true);
  });

  it("records the client graph: modules and every emitted file name", () => {
    const graph = recordClientGraph(context, bundle);
    expect(graph.fileNames).toEqual([
      "index.js",
      "assets/dep-HASH.js",
      "assets/m-HASH.txt",
    ]);
    expect(graph.modules.size).toBe(6);
  });
});
