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
  computeRouterVersions,
  digestDocumentInputs,
  ENCRYPTION_KEY_FILE,
  externalPackage,
  fillRouterVersions,
  portableModuleId,
  portableRegions,
  recordClientGraph,
  recordExternalImports,
  recordServerGraph,
  recordVersionModuleFiles,
  resolveRouterMembers,
  stripServerReferenceMap,
  type BuildDataRecord,
  type BuildModuleEdges,
  type ClientBuildGraph,
  type ComputeRouterVersionsInput,
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

function compute(
  overrides: Partial<ComputeRouterVersionsInput> & {
    files?: Record<string, string>;
  } = {},
) {
  const files = overrides.files ?? serverFiles();
  const encoder = new TextEncoder();
  return computeRouterVersions({
    projectRoot: ROOT,
    server: serverGraph(),
    client: clientGraph(),
    routers: ROUTERS,
    buildData: [],
    readServerFile: (fileName) =>
      fileName in files ? encoder.encode(files[fileName]) : undefined,
    documentDigest: "doc-1",
    ...overrides,
  });
}

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

  it("puts the document digest in the document version only", () => {
    const before = compute().table;
    const after = compute({ documentDigest: "doc-2" }).table;
    for (const id of ["router-a", "router-b", "*"]) {
      expect(after[id]![0]).toBe(before[id]![0]);
      expect(after[id]![1]).not.toBe(before[id]![1]);
    }
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
      expect(
        Object.fromEntries(
          before.details.map((detail) => [
            detail.routerId,
            detail.usesEncryptionKey,
          ]),
        ),
      ).toEqual({ "router-a": true, "router-b": false, "*": true });
    });

    it("is ignored when no code encrypts with it", () => {
      expect(compute({ files: filesWithKey("key-1") }).table).toEqual(
        compute({ files: filesWithKey("key-2") }).table,
      );
    });
  });

  describe("dependencies the bundle leaves external", () => {
    // Router B's chunk imports a package and a subpath of a scoped one; what
    // is installed for them is not in any chunk.
    function graphWithExternals(): ServerBuildGraph {
      const graph = serverGraph();
      return {
        ...graph,
        chunks: graph.chunks.map((chunk) =>
          chunk.fileName === "assets/handler-BBBBBBBB.js"
            ? {
                ...chunk,
                externalImports: [
                  "marked",
                  "@scope/db/client",
                  "node:fs",
                  "fs",
                  "cloudflare:workers",
                  "../__vite_rsc_assets_manifest.js",
                ],
              }
            : chunk,
        ),
      };
    }
    const installed =
      (versions: Record<string, string>) =>
      (name: string): string | undefined =>
        name in versions ? `${name}@${versions[name]}` : undefined;

    it("puts what is installed in the data version of the routers importing it", () => {
      const at = (marked: string) =>
        compute({
          server: graphWithExternals(),
          describeExternal: installed({ marked, "@scope/db": "2.0.0" }),
        });
      const before = at("1.0.0");
      const after = at("1.0.1");
      expect(after.table["router-b"]![0]).not.toBe(
        before.table["router-b"]![0],
      );
      expect(after.table["router-a"]).toEqual(before.table["router-a"]);
      expect(after.table["*"]![0]).not.toBe(before.table["*"]![0]);
    });

    it("names packages, not specifiers, and skips builtins, schemes and paths", () => {
      const b = compute({
        server: graphWithExternals(),
        describeExternal: installed({ marked: "1.0.0", "@scope/db": "2.0.0" }),
      }).details.find((detail) => detail.routerId === "router-b")!;
      expect(
        b.dataInputs
          .map(([name]) => name)
          .filter((name) => name.startsWith("external ")),
      ).toEqual(["external @scope/db", "external marked"]);
    });

    it("leaves out a package that is not installed", () => {
      expect(
        compute({
          server: graphWithExternals(),
          describeExternal: () => undefined,
        }).table,
      ).toEqual(compute().table);
    });

    it("splits a specifier into its package", () => {
      expect(externalPackage("marked")).toBe("marked");
      expect(externalPackage("marked/lib/x.js")).toBe("marked");
      expect(externalPackage("@scope/db/client")).toBe("@scope/db");
      expect(externalPackage("node:fs")).toBeUndefined();
      expect(externalPackage("fs")).toBeUndefined();
      expect(externalPackage("cloudflare:workers")).toBeUndefined();
      expect(externalPackage("./local.js")).toBeUndefined();
      expect(externalPackage("/abs/file.js")).toBeUndefined();
    });

    // @cloudflare/vite-plugin's marker for a text module it emits as an asset.
    // Taken for a package, it is one nobody can find: a new version per build.
    it("does not take another plugin's import marker for a package", () => {
      expect(
        externalPackage(
          "__CLOUDFLARE_MODULE__Text__/app/dist/rsc/manifest.txt__CLOUDFLARE_MODULE__",
        ),
      ).toBeUndefined();
      expect(externalPackage("_private")).toBeUndefined();
      expect(externalPackage("@scope/_private")).toBeUndefined();
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

  it("does not depend on the directory in a virtual module's region comment", () => {
    const withCss = (root: string): ReturnType<typeof compute> => {
      const id = `\0virtual:vite-rsc/css?type=rsc&id=${encodeURIComponent(`${root}/src/a/urls.tsx`)}&lang.js`;
      const graph = serverGraph();
      const rooted = (value: string) => value.replaceAll(ROOT, root);
      return computeRouterVersions({
        projectRoot: root,
        server: {
          ...graph,
          modules: new Map(
            [...graph.modules].map(([key, value]) => [
              rooted(key),
              {
                imports: value.imports.map(rooted),
                dynamicImports: value.dynamicImports.map(rooted),
              },
            ]),
          ),
          chunks: graph.chunks.map((chunk) => ({
            ...chunk,
            moduleIds: [
              ...chunk.moduleIds.map(rooted),
              ...(chunk.fileName === "assets/handler-AAAAAAAA.js" ? [id] : []),
            ],
          })),
        },
        client: undefined,
        routers: ROUTERS.map((router) => ({
          ...router,
          moduleId: rooted(router.moduleId),
        })),
        buildData: [],
        readServerFile: (fileName) => {
          const files: Record<string, string> = {
            ...serverFiles(),
            "assets/handler-AAAAAAAA.js": `//#region \\0${id.slice(1)}\nvar Resources = 1;\n//#endregion\na();`,
          };
          return fileName in files
            ? new TextEncoder().encode(files[fileName])
            : undefined;
        },
        documentDigest: "doc-1",
      });
    };
    expect(withCss("/home/ci/checkout").table).toEqual(
      withCss("/Users/dev/project").table,
    );
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
    const { details } = compute({
      buildData: [
        { kind: "prerender", key: "p/1", digest: "d", routerId: "router-b" },
      ],
    });
    const b = details.find((detail) => detail.routerId === "router-b")!;
    expect(b.dataInputs.map(([name]) => name)).toEqual(
      [...b.dataInputs.map(([name]) => name)].sort(),
    );
    expect(b.dataInputs.every(([name]) => name.startsWith("file "))).toBe(true);
    expect(b.documentInputs).toEqual([
      ["prerender p/1", "d"],
      ["ssr-and-client", "doc-1"],
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

describe("digestDocumentInputs", () => {
  const input = () => ({
    ssrFiles: [
      { fileName: "index.js", source: new TextEncoder().encode("ssr();") },
      { fileName: "assets/a.js", source: new TextEncoder().encode("a();") },
    ],
    clientFileNames: ["assets/index-11111111.js", "assets/react-22222222.js"],
    base: "/",
  });

  it("is independent of the order files are listed in", () => {
    const base = input();
    expect(
      digestDocumentInputs({
        ...base,
        ssrFiles: [...base.ssrFiles].reverse(),
        clientFileNames: [...base.clientFileNames].reverse(),
      }),
    ).toBe(digestDocumentInputs(base));
  });

  it("changes with the SSR output, a client asset name, or the base", () => {
    const base = input();
    const digest = digestDocumentInputs(base);
    expect(
      digestDocumentInputs({
        ...base,
        ssrFiles: [
          base.ssrFiles[0]!,
          { fileName: "assets/a.js", source: new TextEncoder().encode("b();") },
        ],
      }),
    ).not.toBe(digest);
    expect(
      digestDocumentInputs({
        ...base,
        clientFileNames: ["assets/index-33333333.js", base.clientFileNames[1]!],
      }),
    ).not.toBe(digest);
    expect(digestDocumentInputs({ ...base, base: "/app/" })).not.toBe(digest);
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

describe("portableRegions", () => {
  it("rewrites a virtual module's region comment and nothing else", () => {
    const source = [
      `//#region \\0virtual:vite-rsc/css?type=rsc&id=${encodeURIComponent("/project/src/note.tsx")}&lang.js`,
      `var a = "/project/src/kept.ts";`,
      "//#endregion",
      "//#region src/note.tsx",
      "//#endregion",
    ].join("\n");
    expect(portableRegions(source, ROOT)).toBe(
      [
        "//#region \\0virtual:vite-rsc/css?type=rsc&id=src/note.tsx&lang.js",
        `var a = "/project/src/kept.ts";`,
        "//#endregion",
        "//#region src/note.tsx",
        "//#endregion",
      ].join("\n"),
    );
  });

  it("returns a source without virtual regions as it is", () => {
    const source = "//#region src/a.ts\na();\n//#endregion";
    expect(portableRegions(source, ROOT)).toBe(source);
  });
});

describe("graph recording", () => {
  const RUNTIME = "/n/@vitejs/plugin-rsc/dist/utils/encryption-runtime.js";
  const code: Record<string, string | null> = {
    "/a.ts": `registerServerReference(save).bind(null, __vite_rsc_encryption_runtime.encryptActionBoundArgs([id]))`,
    "/file-level-action.ts": `registerServerReference(ping, "id", "ping")`,
    "/no-code.ts": null,
  };
  const context = {
    getModuleIds: () => [
      "/a.ts",
      "/b.ts",
      "/file-level-action.ts",
      "/no-code.ts",
    ],
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

  it("records the server graph: modules, chunks and assets", () => {
    const graph = recordServerGraph(context, bundle);
    expect(graph.modules.get("/b.ts")).toEqual({
      imports: [],
      dynamicImports: [],
    });
    expect(graph.chunks).toEqual([
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
    ]);
    expect(graph.assets).toEqual([
      { fileName: "assets/m-HASH.txt", name: "m.txt" },
    ]);
  });

  // plugin-rsc imports its encryption runtime into every "use server" module;
  // only a module that calls the encrypt function depends on the key.
  it("marks a module that encrypts bound arguments, not one that only imports the runtime", () => {
    const { modules } = recordServerGraph(context, bundle);
    expect(modules.get("/a.ts")).toEqual({
      imports: ["/b.ts", RUNTIME],
      dynamicImports: ["/c.ts"],
      encryptsBoundArgs: true,
    });
    expect(modules.get("/file-level-action.ts")!.encryptsBoundArgs).toBe(
      undefined,
    );
    // No code to look at: counted as encrypting.
    expect(modules.get("/no-code.ts")!.encryptsBoundArgs).toBe(true);
  });

  it("records what a bundle imports from outside it", () => {
    expect(recordExternalImports(bundle)).toEqual(["marked", "node:fs", "pg"]);
  });

  it("records the client graph: modules and every emitted file name", () => {
    const graph = recordClientGraph(context, bundle);
    expect(graph.fileNames).toEqual([
      "index.js",
      "assets/dep-HASH.js",
      "assets/m-HASH.txt",
    ]);
    expect(graph.modules.size).toBe(4);
  });
});
