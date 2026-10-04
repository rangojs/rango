/**
 * The post-build cache version phase against files on disk: it reads the
 * output as it ships, writes the table into the built version module, and
 * leaves a report of what each version was computed from.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  readServerResources,
  runRouterVersionsPhase,
  VERSIONS_REPORT_FILE,
} from "../router-versions-phase.js";
import { createDiscoveryState, type DiscoveryState } from "../state.js";
import {
  configureEncryptionKey,
  resetEncryptionKeyForTests,
} from "../../encryption-key.js";
import type { BuildModuleEdges } from "../build-versions.js";

const VERSION_MODULE = "\0@rangojs/router:version";
const PLACEHOLDER = "__RANGO_ROUTER_VERSIONS__";
const STABLE_KEY = Buffer.alloc(32, 3).toString("base64");

let root: string;
let logs: string[];
let warnings: string[];

const write = (file: string, content: string) => {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const read = (file: string) => readFileSync(join(root, file), "utf-8");

const EMPTY_MANIFEST = `export default {\n  "serverResources": {}\n}`;

const edges = (
  imports: string[] = [],
  dynamicImports: string[] = [],
): BuildModuleEdges => ({ imports, dynamicImports });

/** A one-router build on disk, and the state the build hooks recorded. */
function makeBuild(
  options: {
    usesKey?: boolean;
    routerBody?: string;
    externalImports?: string[];
  } = {},
): DiscoveryState {
  const router = join(root, "src/router.tsx");
  write("dist/rsc/index.js", `import "./assets/app-AAAAAAAA.js";\nentry();`);
  write(
    "dist/rsc/assets/app-AAAAAAAA.js",
    `${options.routerBody ?? "router();"}\nvar ROUTER_VERSIONS = ${PLACEHOLDER};\nvar VERSION = ROUTER_VERSIONS["*"][1];`,
  );
  // plugin-rsc writes the key file only when a chunk reads the key.
  if (options.usesKey) {
    write("dist/rsc/__vite_rsc_encryption_key.js", `export default "k";\n`);
  }
  write("dist/rsc/__vite_rsc_assets_manifest.js", EMPTY_MANIFEST);
  write("dist/ssr/index.js", "ssr();");
  write("dist/ssr/__vite_rsc_assets_manifest.js", EMPTY_MANIFEST);

  const state = createDiscoveryState(undefined, { preset: "node" });
  state.projectRoot = root;
  state.isBuildMode = true;
  state.perRouterManifests = [
    { id: "router-1", routeManifest: { home: "/" }, sourceFile: router },
  ];
  state.serverBuildGraph = {
    modules: new Map([
      [
        router,
        {
          ...edges([VERSION_MODULE]),
          ...(options.usesKey ? { encryptsBoundArgs: true } : undefined),
        },
      ],
      [VERSION_MODULE, edges()],
    ]),
    chunks: [
      { fileName: "index.js", name: "index", moduleIds: [] },
      {
        fileName: "assets/app-AAAAAAAA.js",
        name: "app",
        moduleIds: [router, VERSION_MODULE],
        externalImports: options.externalImports,
      },
    ],
    assets: [],
  };
  state.clientBuildGraph = {
    modules: new Map(),
    fileNames: ["assets/index-11111111.js"],
  };
  state.ssrBundle = {
    chunks: [{ fileName: "index.js", name: "index", moduleIds: [] }],
    assets: [{ fileName: "index.js.map", name: "index.js.map" }],
  };
  state.versionModuleFiles = new Map([["rsc", ["assets/app-AAAAAAAA.js"]]]);
  return state;
}

const builder = () => ({
  config: { base: "/" },
  environments: {
    rsc: { config: { build: { outDir: join(root, "dist/rsc") } } },
    ssr: { config: { build: { outDir: join(root, "dist/ssr") } } },
  },
});

function builtTable(): Record<string, [string, string]> {
  const source = read("dist/rsc/assets/app-AAAAAAAA.js");
  return JSON.parse(source.match(/ROUTER_VERSIONS = (\{.*\});/)![1]!);
}

beforeEach(() => {
  // realpath: os.tmpdir() is a symlink on macOS.
  root = realpathSync(mkdtempSync(join(tmpdir(), "rango-versions-phase-")));
  logs = [];
  warnings = [];
  vi.spyOn(console, "log").mockImplementation((line) => {
    logs.push(String(line));
  });
  vi.spyOn(console, "warn").mockImplementation((line) => {
    warnings.push(String(line));
  });
  delete process.env.RANGO_ENCRYPTION_KEY;
  resetEncryptionKeyForTests();
  configureEncryptionKey(STABLE_KEY);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetEncryptionKeyForTests();
  rmSync(root, { recursive: true, force: true });
});

describe("readServerResources", () => {
  it("is empty for a manifest without server stylesheets", () => {
    expect(
      readServerResources(
        `export default {\n  "clientReferenceDeps": {},\n  "serverResources": {}\n}`,
      ).size,
    ).toBe(0);
  });

  it("returns each entry's source text, runtime expressions included", () => {
    const manifest = `export default {
  "bootstrapScriptContent": "import(\\"/assets/index-1.js\\")",
  "serverResources": {
    "src/a/layout.tsx": { "js": [], "css": ["/assets/a-AAAA.css"] },
    "src/b/page.tsx": { "js": [], "css": [__base + "assets/b-BBBB.css"] }
  }
}`;
    expect([...readServerResources(manifest)]).toEqual([
      ["src/a/layout.tsx", `{ "js": [], "css": ["/assets/a-AAAA.css"] }`],
      ["src/b/page.tsx", `{ "js": [], "css": [__base + "assets/b-BBBB.css"] }`],
    ]);
  });

  it("is not fooled by the property's text inside a string", () => {
    const manifest = `export default {
  "bootstrapScriptContent": "\\"serverResources\\": {}",
  "serverResources": { "src/a.tsx": { "js": [], "css": ["/a.css"] } }
}`;
    expect([...readServerResources(manifest).keys()]).toEqual(["src/a.tsx"]);
  });

  it("throws on a manifest of another shape", () => {
    expect(() => readServerResources("export default [];")).toThrow(
      /no serverResources object literal/,
    );
    expect(() => readServerResources("not javascript {")).toThrow(
      /no serverResources object literal/,
    );
  });
});

describe("runRouterVersionsPhase", () => {
  it("writes the table into the built version module", () => {
    // Returned for the shell capture phase, which stamps its entries with it.
    const returned = runRouterVersionsPhase(makeBuild(), builder());

    const table = builtTable();
    expect(Object.keys(table)).toEqual(["router-1", "*"]);
    expect(read("dist/rsc/assets/app-AAAAAAAA.js")).not.toContain(PLACEHOLDER);
    expect(returned).toEqual(table);
  });

  it("computes the same versions for the same output", () => {
    runRouterVersionsPhase(makeBuild(), builder());
    const first = builtTable();
    runRouterVersionsPhase(makeBuild(), builder());
    expect(builtTable()).toEqual(first);
  });

  it("hashes the files as they are on disk when it runs", () => {
    // postprocessBundle rewrites chunks after the bundler wrote them; the
    // phase must see the rewritten bytes.
    runRouterVersionsPhase(makeBuild(), builder());
    const before = builtTable();
    runRouterVersionsPhase(
      makeBuild({ routerBody: "routerAfterEviction();" }),
      builder(),
    );
    expect(builtTable()["router-1"]![0]).not.toBe(before["router-1"]![0]);
  });

  it("covers the SSR output and client asset names in the document version only", () => {
    runRouterVersionsPhase(makeBuild(), builder());
    const before = builtTable();

    const state = makeBuild();
    write("dist/ssr/index.js", "ssrChanged();");
    runRouterVersionsPhase(state, builder());
    const afterSsr = builtTable();
    expect(afterSsr["router-1"]![0]).toBe(before["router-1"]![0]);
    expect(afterSsr["router-1"]![1]).not.toBe(before["router-1"]![1]);

    const clientState = makeBuild();
    clientState.clientBuildGraph = {
      modules: new Map(),
      fileNames: ["assets/index-22222222.js"],
    };
    runRouterVersionsPhase(clientState, builder());
    const afterClient = builtTable();
    expect(afterClient["router-1"]![0]).toBe(before["router-1"]![0]);
    expect(afterClient["router-1"]![1]).not.toBe(before["router-1"]![1]);
  });

  it("prints each router's versions with its source file", () => {
    runRouterVersionsPhase(makeBuild(), builder());
    const [data, document] = builtTable()["router-1"]!;
    expect(logs[0]).toMatch(
      /^\[rango\] Cache versions for 1 router\(s\), data \/ document \(\d+\.\dms\):$/,
    );
    expect(logs[1]).toBe(`[rango]   ${data} / ${document}  src/router.tsx`);
  });

  it("leaves a report of what each version was computed from, outside the output", () => {
    runRouterVersionsPhase(makeBuild(), builder());
    expect(VERSIONS_REPORT_FILE.startsWith("node_modules/")).toBe(true);
    const report = JSON.parse(read(VERSIONS_REPORT_FILE));
    const [data, document] = builtTable()["router-1"]!;
    expect(report.routers["router-1"]).toMatchObject({
      source: "src/router.tsx",
      data,
      document,
    });
    expect(Object.keys(report.routers["router-1"].dataInputs)).toEqual([
      expect.stringMatching(/^file app~[0-9a-f]{8}\.js$/),
    ]);
    expect(Object.keys(report.routers["router-1"].documentInputs)).toEqual([
      "ssr-and-client",
    ]);
    expect(Object.keys(report.routers)).toEqual(["router-1", "*"]);
    // The entry chunk: in the whole-build pair and in no router's version.
    expect(report.unownedFiles).toEqual([
      expect.stringMatching(/^index~[0-9a-f]{8}\.js$/),
    ]);
  });

  describe("encryption key note", () => {
    const note = () =>
      logs.find((line) => line.includes("No stable encryption key"));

    it("says so once when a router's version depends on a key generated for this build", () => {
      resetEncryptionKeyForTests();
      configureEncryptionKey(undefined);
      runRouterVersionsPhase(makeBuild({ usesKey: true }), builder());
      expect(note()).toMatch(
        /1 router\(s\) encrypt server-action arguments.*rango\(\{ encryptionKey: process\.env\.RANGO_ENCRYPTION_KEY \}\)/s,
      );
      expect(logs.filter((line) => line.includes("No stable"))).toHaveLength(1);
    });

    it("is silent when the key is stable", () => {
      runRouterVersionsPhase(makeBuild({ usesKey: true }), builder());
      expect(note()).toBeUndefined();
    });

    it("is silent when no router's code encrypts with the key", () => {
      resetEncryptionKeyForTests();
      configureEncryptionKey(undefined);
      runRouterVersionsPhase(makeBuild(), builder());
      expect(note()).toBeUndefined();
    });
  });

  // The stylesheet URL of a server component is read from the assets manifest
  // at run time: no server chunk holds it, and cached Flight does.
  it("puts the stylesheets of a server component in the data version", () => {
    const build = (href: string) => {
      const state = makeBuild();
      write(
        "dist/rsc/__vite_rsc_assets_manifest.js",
        `export default {\n  "clientReferenceDeps": {},\n  "serverResources": {\n    "src/router.tsx": { "js": [], "css": ["${href}"] }\n  }\n}`,
      );
      runRouterVersionsPhase(state, builder());
      return builtTable()["router-1"]!;
    };
    const before = build("/assets/app-AAAA.css");
    const after = build("/assets/app-BBBB.css");
    expect(after[0]).not.toBe(before[0]);
    expect(
      Object.keys(
        JSON.parse(read(VERSIONS_REPORT_FILE)).routers["router-1"].dataInputs,
      ),
    ).toContain("server-css src/router.tsx");
  });

  it("fails the build on an assets manifest it cannot read stylesheets from", () => {
    const state = makeBuild();
    write("dist/rsc/__vite_rsc_assets_manifest.js", "export default [];");
    expect(() => runRouterVersionsPhase(state, builder())).toThrow(
      /__vite_rsc_assets_manifest\.js has no serverResources/,
    );
  });

  // The node preset leaves dependencies external: the chunk says
  // `from "ext-lib"` whatever is installed.
  it("puts what is installed for an external dependency in the data version", () => {
    const build = (version: string) => {
      const state = makeBuild({ externalImports: ["ext-lib/sub", "node:fs"] });
      write(
        "node_modules/ext-lib/package.json",
        JSON.stringify({ name: "ext-lib", version }),
      );
      runRouterVersionsPhase(state, builder());
      return builtTable()["router-1"]!;
    };
    const before = build("1.0.0");
    expect(build("1.0.1")[0]).not.toBe(before[0]);
    expect(build("1.0.0")).toEqual(before);
  });

  // A dependency of unknown content cannot be shown unchanged.
  it("gives a router a new version on every build when an external dependency cannot be found, and says which", () => {
    const build = () => {
      runRouterVersionsPhase(
        makeBuild({ externalImports: ["ghost-pkg", "node:fs"] }),
        builder(),
      );
      return builtTable()["router-1"]!;
    };
    const first = build();
    expect(build()[0]).not.toBe(first[0]);
    expect(
      logs.filter((line) => line.includes("could not be read at build time")),
    ).toHaveLength(2);
    expect(logs.join("\n")).toMatch(
      /1 import\(s\) the server build leaves external could not be read at build time \(ghost-pkg\)/,
    );
  });

  it("digests a file a chunk imports by path", () => {
    const build = (bytes: string) => {
      const state = makeBuild({ externalImports: ["../native.node"] });
      write("dist/rsc/native.node", bytes);
      runRouterVersionsPhase(state, builder());
      return builtTable()["router-1"]!;
    };
    const before = build("v1");
    expect(build("v2")[0]).not.toBe(before[0]);
    expect(build("v1")).toEqual(before);
    expect(logs.join("\n")).not.toContain("could not be read at build time");
  });

  // A workspace package the config left external: its version does not fix
  // its code.
  it("digests the files of a linked external dependency", () => {
    const build = (body: string) => {
      const state = makeBuild({ externalImports: ["@acme/db"] });
      write(
        "packages/db/package.json",
        JSON.stringify({ name: "@acme/db", version: "0.0.0" }),
      );
      write("packages/db/src/index.js", body);
      mkdirSync(join(root, "node_modules/@acme"), { recursive: true });
      rmSync(join(root, "node_modules/@acme/db"), {
        recursive: true,
        force: true,
      });
      symlinkSync(
        join(root, "packages/db"),
        join(root, "node_modules/@acme/db"),
        "dir",
      );
      runRouterVersionsPhase(state, builder());
      return builtTable()["router-1"]!;
    };
    const before = build("export const a = 1;");
    expect(build("export const a = 2;")[0]).not.toBe(before[0]);
    expect(build("export const a = 1;")).toEqual(before);
  });

  // `vite build <root>` from another directory: the test's cwd is not `root`.
  it("reads a relative outDir against the root, not the working directory", () => {
    const state = makeBuild();
    runRouterVersionsPhase(state, {
      config: { base: "/" },
      environments: {
        rsc: { config: { build: { outDir: "dist/rsc" } } },
        ssr: { config: { build: { outDir: "dist/ssr" } } },
      },
    });
    expect(Object.keys(builtTable())).toEqual(["router-1", "*"]);
  });

  // The module is emitted wherever something imports it; an unreplaced
  // placeholder throws on load.
  it("fills the placeholder in every environment that holds the version module", () => {
    const state = makeBuild();
    write(
      "dist/worker/assets/store-BBBBBBBB.js",
      `var ROUTER_VERSIONS = ${PLACEHOLDER};`,
    );
    state.versionModuleFiles.set("worker", ["assets/store-BBBBBBBB.js"]);
    runRouterVersionsPhase(state, {
      ...builder(),
      environments: {
        ...builder().environments,
        worker: { config: { build: { outDir: join(root, "dist/worker") } } },
      },
    });
    expect(read("dist/worker/assets/store-BBBBBBBB.js")).toBe(
      `var ROUTER_VERSIONS = ${JSON.stringify(builtTable())};`,
    );
  });

  // The server materializes a clientUrls() group from a projection of the
  // client module; it is recorded under each of the module's reference ids.
  it("puts a clientUrls() projection in the data version, once per module", () => {
    const build = (loaderId: string) => {
      const state = makeBuild();
      const source = join(root, "src/pages.tsx");
      const projection = {
        version: 1 as const,
        routes: [
          {
            id: "client-route-0",
            pattern: "/first",
            name: "first",
            options: {},
            loaderIds: [loaderId],
            hasLoading: false,
          },
        ],
      };
      state.clientUrlSourceByReferenceId = new Map([
        ["dev-ref", source],
        ["prod-ref", source],
      ]);
      state.clientUrlProjectionMap = new Map([
        ["dev-ref", projection],
        ["prod-ref", projection],
      ]);
      runRouterVersionsPhase(state, builder());
      return builtTable()["router-1"]!;
    };
    const before = build("loader-a");
    expect(build("loader-b")[0]).not.toBe(before[0]);
    expect(
      Object.keys(
        JSON.parse(read(VERSIONS_REPORT_FILE)).routers["router-1"].dataInputs,
      ).filter((name) => name.startsWith("client-urls ")),
    ).toEqual(["client-urls src/pages.tsx"]);
  });

  it("puts what the SSR output leaves external in the document version only", () => {
    const build = (version: string) => {
      const state = makeBuild();
      state.ssrBundle = {
        chunks: [
          {
            fileName: "index.js",
            name: "index",
            moduleIds: [],
            externalImports: ["ssr-lib"],
          },
        ],
        assets: [],
      };
      write(
        "node_modules/ssr-lib/package.json",
        JSON.stringify({ name: "ssr-lib", version }),
      );
      runRouterVersionsPhase(state, builder());
      return builtTable()["router-1"]!;
    };
    const before = build("1.0.0");
    const after = build("2.0.0");
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
  });

  it("fails the build when the version module has no placeholder to fill", () => {
    const state = makeBuild();
    write("dist/rsc/assets/app-AAAAAAAA.js", "router();");
    expect(() => runRouterVersionsPhase(state, builder())).toThrow(
      /Could not write the cache versions into the server build/,
    );
  });

  // One mechanism: a build that cannot compute its versions fails. It never
  // ships a stand-in version that would clear the cache on every deploy.
  it("fails the build when it cannot compute the versions", () => {
    const state = makeBuild();
    rmSync(join(root, "dist/ssr/index.js"));
    mkdirSync(join(root, "dist/ssr/index.js"));
    expect(() => runRouterVersionsPhase(state, builder())).toThrow(
      /Could not compute the cache versions: .*EISDIR/,
    );
    expect(read("dist/rsc/assets/app-AAAAAAAA.js")).toContain(PLACEHOLDER);
  });

  // A version computed without one of these would stay the same when it
  // changes: the client asset names, the SSR bytes, every server file.
  it("fails the build when a bundle was never recorded", () => {
    const without = (clear: (state: DiscoveryState) => void) => () => {
      const state = makeBuild();
      clear(state);
      runRouterVersionsPhase(state, builder());
    };
    expect(without((state) => (state.serverBuildGraph = null))).toThrow(
      /did not record the RSC bundle, so the cache versions cannot be computed/,
    );
    expect(without((state) => (state.clientBuildGraph = null))).toThrow(
      /did not record the client bundle/,
    );
    expect(without((state) => (state.ssrBundle = null))).toThrow(
      /did not record the SSR bundle/,
    );
  });

  // Without it nothing is filled, and the build would throw a ReferenceError
  // at its first import instead.
  it("fails the build when no RSC chunk was recorded as holding the version module", () => {
    const state = makeBuild();
    state.versionModuleFiles = new Map();
    expect(() => runRouterVersionsPhase(state, builder())).toThrow(
      /did not record the RSC chunk that holds the version module/,
    );
    expect(read("dist/rsc/assets/app-AAAAAAAA.js")).toContain(PLACEHOLDER);
  });

  it("fails the build when a listed file is not in its output directory", () => {
    const rsc = makeBuild();
    rmSync(join(root, "dist/rsc/index.js"));
    expect(() => runRouterVersionsPhase(rsc, builder())).toThrow(
      /Could not compute the cache versions: the RSC bundle lists index\.js, which is not in its output directory/,
    );
    const ssr = makeBuild();
    rmSync(join(root, "dist/ssr/__vite_rsc_assets_manifest.js"));
    expect(() => runRouterVersionsPhase(ssr, builder())).toThrow(
      /the SSR bundle lists __vite_rsc_assets_manifest\.js, which is not in its output directory/,
    );
    const manifest = makeBuild();
    rmSync(join(root, "dist/rsc/__vite_rsc_assets_manifest.js"));
    expect(() => runRouterVersionsPhase(manifest, builder())).toThrow(
      /__vite_rsc_assets_manifest\.js is not in the RSC output directory/,
    );
  });

  it("fails the build when a router encrypts and the key file is missing", () => {
    const state = makeBuild({ usesKey: true });
    rmSync(join(root, "dist/rsc/__vite_rsc_encryption_key.js"));
    expect(() => runRouterVersionsPhase(state, builder())).toThrow(
      /Could not compute the cache versions: 1 server module\(s\) encrypt action arguments \(src\/router\.tsx\), but __vite_rsc_encryption_key\.js is not in the RSC output directory/,
    );
  });

  it("marks a router whose module is not in the server bundle as whole-build", () => {
    const state = makeBuild();
    state.perRouterManifests.push({
      id: "router-2",
      routeManifest: {},
      sourceFile: join(root, "src/not-bundled.tsx"),
    });
    runRouterVersionsPhase(state, builder());
    const table = builtTable();
    expect(Object.keys(table)).toEqual(["router-1", "*"]);
    const [data, document] = table["*"]!;
    expect(logs[0]).toContain("Cache versions for 2 router(s)");
    expect(logs[2]).toBe(
      `[rango]   ${data} / ${document}  src/not-bundled.tsx (whole build)`,
    );
  });

  it("does nothing outside a build", () => {
    const dev = makeBuild();
    dev.isBuildMode = false;
    dev.serverBuildGraph = null;
    runRouterVersionsPhase(dev, builder());
    expect(read("dist/rsc/assets/app-AAAAAAAA.js")).toContain(PLACEHOLDER);
    expect(existsSync(join(root, VERSIONS_REPORT_FILE))).toBe(false);
  });
});
