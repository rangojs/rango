/**
 * Build-level contract of the per-router cache versions: real `vite build`
 * runs of a two-app host fixture (__fixtures__/cache-versions), one per
 * scenario, comparing the versions each router gets with the baseline's.
 *
 * What a consumer relies on, row by row (docs/design/per-app-cache-version.md,
 * "What each kind of deploy does"): a rebuild keeps every version, a change to
 * one app's server code changes that app only, a client change keeps cached
 * data and replaces stored HTML, and the same source builds to the same
 * versions wherever it is checked out.
 */
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildFixture,
  createFixtureWorkspace,
  OTHER_ENCRYPTION_KEY,
  type FixtureBuild,
  type FixtureScenario,
} from "./helpers/build-cache-versions-fixture.js";

const A = "src/apps/a/router.tsx";
const B = "src/apps/b/router.tsx";
const CONCURRENT_BUILDS = 3;

const scenarios = {
  baseline: {},
  // Same source, same directory name, different parent directory.
  otherDirectory: {},
  serverTextInA: {
    edits: {
      "src/apps/a/urls.tsx": (source: string) =>
        source.replace('greeting("app A")', 'greeting("app A, edited")'),
    },
  },
  routeAddedToA: {
    edits: {
      "src/apps/a/urls.tsx": (source: string) =>
        source.replace(
          'path("/note/:id"',
          'path("/about", () => <main>About A</main>, { name: "about" }),\n  path("/note/:id"',
        ),
    },
  },
  clientComponentInA: {
    edits: {
      "src/apps/a/Counter.tsx": (source: string) =>
        source.replace("Count: {count}", "Clicks: {count}"),
    },
  },
  sharedServerModule: {
    edits: {
      "src/shared/greeting.ts": (source: string) =>
        source.replace("Hello from", "Greetings from"),
    },
  },
  otherEncryptionKey: { encryptionKey: OTHER_ENCRYPTION_KEY },
  // An action only a client component imports: the server graph of app A
  // never reaches actions.ts.
  clientOnlyActionBodyInA: {
    edits: {
      "src/apps/a/actions.ts": (source: string) =>
        source.replace("likes += 1;", "likes += 2;"),
    },
  },
  actionAddedToA: {
    edits: {
      "src/apps/a/actions.ts": (source: string) =>
        `${source}\nexport async function unlike(): Promise<void> {\n  likes -= 1;\n}\n`,
    },
  },
  hostEntry: {
    edits: {
      "src/host.rsc.tsx": (source: string) =>
        source.replace(
          "export default hostRouter;",
          'hostRouter.host(["c.localhost"]).map(() => new Response("c"));\n\nexport default hostRouter;',
        ),
    },
  },
  // Code app B runs that only its handler module reaches: the module calling
  // createRouter() never imports wiring.ts.
  wiringOfB: {
    edits: {
      "src/apps/b/wiring.ts": (source: string) =>
        source.replace("b v1", "b v2"),
    },
  },
  // A clientUrls() route of app B declares another loader: a change to a
  // "use client" module that changes what the server runs for the route.
  clientUrlsLoaderOfB: {
    edits: {
      "src/apps/b/pages.tsx": (source: string) =>
        source.replace(
          '{ name: "first" }, () => [loader(FirstLoader)]',
          '{ name: "first" }, () => [loader(SecondLoader)]',
        ),
    },
  },
  // A stylesheet only a server component of app A imports.
  serverComponentCssInA: {
    edits: {
      "src/apps/a/note.css": (source: string) => source.replace("red", "blue"),
    },
  },
  // A lockfile bump of a dependency app B's server code imports and the node
  // preset leaves external: no built chunk changes.
  externalDependencyOfB: {
    edits: {
      "node_modules/ext-lib/package.json": (source: string) =>
        source.replace('"version": "1.0.0"', '"version": "1.0.1"'),
    },
  },
  // The same for a dependency of that dependency.
  transitiveExternalDependencyOfB: {
    edits: {
      "node_modules/ext-dep/package.json": (source: string) =>
        source.replace('"version": "1.0.0"', '"version": "1.1.0"'),
    },
  },
} satisfies Record<string, FixtureScenario>;

type ScenarioName = keyof typeof scenarios;

describe("per-router cache versions of a real build", () => {
  const workspace = createFixtureWorkspace();
  const builds = {} as Record<ScenarioName, FixtureBuild>;

  beforeAll(async () => {
    const pending = Object.keys(scenarios) as ScenarioName[];
    // A few builds at a time. All of them at once saturate the machine for
    // seconds and trip the real-timer suites sharing the run (measured: a
    // 20 ms margin in rsc/__tests__/stream-idle.test.ts).
    await Promise.all(
      Array.from({ length: CONCURRENT_BUILDS }, async () => {
        for (let name = pending.shift(); name; name = pending.shift()) {
          // Every copy is named "app" under its own parent, so two copies
          // differ only in the directories above the project root.
          builds[name] = await buildFixture(
            join(workspace.dir, name, "app"),
            scenarios[name],
          );
        }
      }),
    );
  }, 240_000);

  afterAll(() => workspace.cleanup());

  const versionsOf = (name: ScenarioName, router: string) => {
    const { data, document } = builds[name].routers[router]!;
    return { data, document };
  };
  /** Names of the inputs whose digest differs from the baseline's. */
  const changedInputs = (name: ScenarioName, router: string): string[] => {
    const base = builds.baseline.routers[router]!;
    const next = builds[name].routers[router]!;
    const changed = new Set<string>();
    for (const kind of ["dataInputs", "documentInputs"] as const) {
      for (const key of new Set([
        ...Object.keys(base[kind]),
        ...Object.keys(next[kind]),
      ])) {
        if (base[kind][key] !== next[kind][key]) changed.add(key);
      }
    }
    return [...changed].sort();
  };

  it("gives each router its own data and document version", () => {
    const { routers, whole } = builds.baseline;
    expect(Object.keys(routers).sort()).toEqual([A, B]);
    const all = [routers[A]!, routers[B]!, whole].flatMap((entry) => [
      entry.data,
      entry.document,
    ]);
    for (const version of all) expect(version).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set(all).size).toBe(all.length);
  });

  it("builds the same source in another directory to the same versions", () => {
    expect(builds.otherDirectory.root).not.toBe(builds.baseline.root);
    expect(builds.otherDirectory.table).toEqual(builds.baseline.table);
  });

  it("writes the table into the built version module and nothing else varies", () => {
    const assets = join(builds.baseline.root, "dist/rsc/assets");
    const holders = readdirSync(assets).filter((file) =>
      readFileSync(join(assets, file), "utf-8").includes("ROUTER_VERSIONS ="),
    );
    expect(holders).toHaveLength(1);
    const source = readFileSync(join(assets, holders[0]!), "utf-8");
    expect(source).not.toContain("__RANGO_ROUTER_VERSIONS__");
    expect(source).toContain(
      `ROUTER_VERSIONS = ${JSON.stringify(
        Object.fromEntries(
          Object.entries(builds.baseline.table).sort(([a], [b]) =>
            a === "*" ? 1 : b === "*" ? -1 : 0,
          ),
        ),
      )}`,
    );
  });

  const builtServerSources = (name: ScenarioName): string[] => {
    const dist = join(builds[name].root, "dist/rsc");
    return (
      readdirSync(dist, { recursive: true, encoding: "utf-8" }) as string[]
    )
      .filter((file) => /\.m?js$/.test(file))
      .map((file) => readFileSync(join(dist, file), "utf-8"));
  };

  // Regression: discovery (a dev server) and the bundle derived a router's id
  // from different lines when a comment sat above createRouter(), as in app
  // A's router. The table was then keyed by ids no running router had, and
  // every router served with the whole-build pair.
  it("keys the table by the ids the built routers carry", () => {
    const builtIds = builtServerSources("baseline").flatMap((source) =>
      [...source.matchAll(/\$\$id: "([0-9a-f]{8})"/g)].map((match) => match[1]),
    );
    expect(builtIds).toHaveLength(2);
    expect(
      Object.keys(builds.baseline.table)
        .filter((key) => key !== "*")
        .sort(),
    ).toEqual([...builtIds].sort());
  });

  it("ships a root-relative $$sourceFile, not the build directory", () => {
    const sources = builtServerSources("baseline");
    expect(
      sources.some((source) => source.includes(`$$sourceFile: "${A}"`)),
    ).toBe(true);
    for (const source of sources) {
      expect(source).not.toContain(builds.baseline.root);
    }
  });

  it("changes only app A for a server-only change in app A", () => {
    expect(versionsOf("serverTextInA", B)).toEqual(versionsOf("baseline", B));
    expect(versionsOf("serverTextInA", A).data).not.toBe(
      versionsOf("baseline", A).data,
    );
    expect(versionsOf("serverTextInA", A).document).not.toBe(
      versionsOf("baseline", A).document,
    );
  });

  it("changes only app A when a route is added to app A", () => {
    expect(versionsOf("routeAddedToA", B)).toEqual(versionsOf("baseline", B));
    expect(versionsOf("routeAddedToA", A).data).not.toBe(
      versionsOf("baseline", A).data,
    );
  });

  it("keeps every data version and replaces every document version for a client change", () => {
    for (const router of [A, B]) {
      expect(versionsOf("clientComponentInA", router).data).toBe(
        versionsOf("baseline", router).data,
      );
      expect(versionsOf("clientComponentInA", router).document).not.toBe(
        versionsOf("baseline", router).document,
      );
      expect(changedInputs("clientComponentInA", router)).toEqual([
        "ssr-and-client",
      ]);
    }
  });

  it("changes both apps when a server module they share changes", () => {
    for (const router of [A, B]) {
      expect(versionsOf("sharedServerModule", router).data).not.toBe(
        versionsOf("baseline", router).data,
      );
    }
  });

  // App B has a file-level "use server" action with no bound arguments.
  // plugin-rsc imports its encryption runtime into every "use server" module,
  // so reaching the key module is not the same as encrypting with the key.
  it("changes the router that encrypts with the key when the key changes, and no other", () => {
    expect(changedInputs("otherEncryptionKey", A)).toEqual(["encryption-key"]);
    expect(versionsOf("otherEncryptionKey", A).data).not.toBe(
      versionsOf("baseline", A).data,
    );
    expect(versionsOf("otherEncryptionKey", B)).toEqual(
      versionsOf("baseline", B),
    );
  });

  it("counts a server action only a client component imports as its app's code", () => {
    expect(versionsOf("clientOnlyActionBodyInA", A).data).not.toBe(
      versionsOf("baseline", A).data,
    );
    expect(versionsOf("clientOnlyActionBodyInA", B)).toEqual(
      versionsOf("baseline", B),
    );
  });

  it("keeps app B when app A adds a server action", () => {
    expect(versionsOf("actionAddedToA", A).data).not.toBe(
      versionsOf("baseline", A).data,
    );
    expect(versionsOf("actionAddedToA", B)).toEqual(versionsOf("baseline", B));
  });

  // Regression: a router's code was walked from the module that calls
  // createRouter() only, so what the modules importing the router run (the
  // mounted handler, middleware attached with .use() elsewhere) was in no
  // version and cached output outlived a change to it.
  it("covers code that only a module importing the router reaches", () => {
    expect(versionsOf("wiringOfB", B).data).not.toBe(
      versionsOf("baseline", B).data,
    );
    expect(versionsOf("wiringOfB", A)).toEqual(versionsOf("baseline", A));
  });

  // Regression: the server materializes a clientUrls() group from a projection
  // of the client module (loaders, loading, transitions, route ids). The
  // projection ships in the routes registry, which sits in the host entry and
  // in no lazily mounted app's chunks, so a change to it left the app's data
  // version alone while cached segments held the old routes' output.
  it("changes app B's data version when a clientUrls() route of B changes what the server runs", () => {
    expect(versionsOf("clientUrlsLoaderOfB", B).data).not.toBe(
      versionsOf("baseline", B).data,
    );
    expect(
      changedInputs("clientUrlsLoaderOfB", B).filter((name) =>
        name.startsWith("client-urls "),
      ),
    ).toHaveLength(1);
    expect(versionsOf("clientUrlsLoaderOfB", A).data).toBe(
      versionsOf("baseline", A).data,
    );
  });

  // Regression: plugin-rsc renders a server component's stylesheet as a
  // <link> whose hashed URL comes from the assets manifest at run time, so a
  // CSS-only change left every server chunk, and the data version, unchanged
  // while cached Flight kept linking the old file.
  it("changes app A's data version when a stylesheet its server component imports changes", () => {
    expect(changedInputs("serverComponentCssInA", A)).toContain(
      "server-css src/apps/a/note.tsx",
    );
    expect(versionsOf("serverComponentCssInA", A).data).not.toBe(
      versionsOf("baseline", A).data,
    );
    expect(versionsOf("serverComponentCssInA", B).data).toBe(
      versionsOf("baseline", B).data,
    );
  });

  // Regression: the node preset leaves server dependencies external, so the
  // built chunk says `from "ext-lib"` whatever is installed and a lockfile
  // bump changed nothing that was hashed.
  it("changes app B when a dependency its server code leaves external is bumped", () => {
    expect(changedInputs("externalDependencyOfB", B)).toEqual([
      "external ext-lib",
    ]);
    expect(versionsOf("externalDependencyOfB", B).data).not.toBe(
      versionsOf("baseline", B).data,
    );
    expect(versionsOf("externalDependencyOfB", A)).toEqual(
      versionsOf("baseline", A),
    );
  });

  it("follows an external dependency's own dependencies", () => {
    expect(changedInputs("transitiveExternalDependencyOfB", B)).toEqual([
      "external ext-lib",
    ]);
    expect(versionsOf("transitiveExternalDependencyOfB", A)).toEqual(
      versionsOf("baseline", A),
    );
  });

  it("keeps both apps when only the host entry changes", () => {
    expect(builds.hostEntry.table["*"]).not.toEqual(builds.baseline.table["*"]);
    for (const router of [A, B]) {
      expect(versionsOf("hostEntry", router)).toEqual(
        versionsOf("baseline", router),
      );
    }
  });
});
