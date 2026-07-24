import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCombinedRouteMapWithSearch,
  resolveImportedVariable,
} from "../route-types/include-resolution.js";
import {
  findUrlsVariableNames,
  writePerModuleRouteTypesForFile,
} from "../route-types/per-module-writer.js";
import { generateRouteTypesSource } from "../route-types/codegen.js";
import {
  buildCombinedRouteMapForRouterFile,
  detectUnresolvableIncludes,
  writeCombinedRouteTypes,
} from "../route-types/router-processing.js";

describe("clientUrls static route type generation", () => {
  const tempDirs: string[] = [];

  function createTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "rango-client-urls-types-"));
    tempDirs.push(dir);
    return dir;
  }

  function writeClientUrls(dir: string): string {
    const urlsPath = join(dir, "app.urls.tsx");
    writeFileSync(
      urlsPath,
      `import { clientUrls } from "@rangojs/router/client";
const ClientPage = () => null;
export default clientUrls(({ path }) => [
  path("/client/:id", ClientPage, {
    name: "client",
    search: { tab: "string?" },
  }),
  path("/client-conflict", ClientPage, {
    name: "conflict",
    search: { client: "boolean?" },
  }),
]);
`,
    );
    return urlsPath;
  }

  const inlineServerUrls = `({ path }) => [
  path("/server/:slug", () => null, {
    name: "server",
    search: { q: "string" },
  }),
  path("/server-conflict", () => null, { name: "conflict" }),
]`;

  function writeMultiMountRouter(
    dir: string,
    order: "server-first" | "client-first",
  ): string {
    const routerPath = join(dir, "router.tsx");
    const calls =
      order === "server-first"
        ? `.routes(${inlineServerUrls}).routes(appUrls)`
        : `.routes(appUrls).routes(${inlineServerUrls})`;
    writeFileSync(
      routerPath,
      `import { createRouter } from "@rangojs/router";
import appUrls from "./app.urls.js";
export const router = createRouter()${calls};
`,
    );
    return routerPath;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves default imports without regressing combined named imports", () => {
    const code = `import appUrls, { apiUrls as api } from "./app.urls.js";`;

    expect(resolveImportedVariable(code, "appUrls")).toEqual({
      specifier: "./app.urls.js",
      exportedName: "default",
    });
    expect(resolveImportedVariable(code, "api")).toEqual({
      specifier: "./app.urls.js",
      exportedName: "apiUrls",
    });
  });

  it("resolves an inline default clientUrls export for direct root mounting", () => {
    const dir = createTempDir();
    const urlsPath = join(dir, "app.urls.tsx");
    const routerPath = join(dir, "router.tsx");
    writeFileSync(
      urlsPath,
      `import { clientUrls } from "@rangojs/router/client";
const ProductPage = () => null;
export default clientUrls(({ path }) => [
  path("/products/:id", ProductPage, {
    name: "product",
    search: { q: "string", page: "number?" },
  }),
]);
`,
    );
    writeFileSync(
      routerPath,
      `import { createRouter } from "@rangojs/router";
import appUrls from "./app.urls.js";
export const router = createRouter().routes(appUrls);
`,
    );

    expect(buildCombinedRouteMapWithSearch(urlsPath, "default")).toEqual({
      routes: { product: "/products/:id" },
      searchSchemas: {
        product: { q: "string", page: "number?" },
      },
    });
    expect(buildCombinedRouteMapForRouterFile(routerPath)).toEqual({
      routes: { product: "/products/:id" },
      searchSchemas: {
        product: { q: "string", page: "number?" },
      },
    });

    writePerModuleRouteTypesForFile(urlsPath);

    const genPath = join(dir, "app.urls.gen.ts");
    expect(existsSync(genPath)).toBe(true);
    const generated = readFileSync(genPath, "utf-8");
    expect(generated).toContain(
      'product: { path: "/products/:id", search: { q: "string", page: "number?" } }',
    );
  });

  it("resolves a clientUrls variable exported as default", () => {
    const dir = createTempDir();
    const urlsPath = join(dir, "account.urls.ts");
    const source = `import { clientUrls } from "@rangojs/router/client";
const AccountPage = () => null;
const appUrls = clientUrls(({ path }) => [
  path("/accounts/:accountId", AccountPage, { name: "account" }),
]);
export default appUrls;
`;
    writeFileSync(urlsPath, source);

    expect(
      findUrlsVariableNames(`${source}\nconst serverUrls = urls(() => []);`),
    ).toEqual(["appUrls", "serverUrls"]);
    expect(buildCombinedRouteMapWithSearch(urlsPath, "default")).toEqual({
      routes: { account: "/accounts/:accountId" },
      searchSchemas: {},
    });

    writePerModuleRouteTypesForFile(urlsPath);

    const generated = readFileSync(join(dir, "account.urls.gen.ts"), "utf-8");
    expect(generated).toContain('account: "/accounts/:accountId"');
  });

  it("continues to resolve an inline default urls export", () => {
    const dir = createTempDir();
    const urlsPath = join(dir, "server.urls.ts");
    writeFileSync(
      urlsPath,
      `import { urls } from "@rangojs/router";
export default urls(({ path }) => [
  path("/health", () => null, { name: "health" }),
]);
`,
    );

    expect(buildCombinedRouteMapWithSearch(urlsPath, "default")).toEqual({
      routes: { health: "/health" },
      searchSchemas: {},
    });
  });

  it("accepts a default clientUrls target through static include resolution", () => {
    const dir = createTempDir();
    const childPath = join(dir, "client.urls.tsx");
    const parentPath = join(dir, "root.urls.ts");
    writeFileSync(
      childPath,
      `import { clientUrls } from "@rangojs/router/client";
const ProfilePage = () => null;
export default clientUrls(({ path }) => [
  path("/profile/:userId", ProfilePage, { name: "profile" }),
]);
`,
    );
    writeFileSync(
      parentPath,
      `import { urls } from "@rangojs/router";
export const rootUrls = urls(({ include }) => [
  include("/client", () => import("./client.urls.js"), { name: "client" }),
]);
`,
    );

    expect(buildCombinedRouteMapWithSearch(parentPath, "rootUrls")).toEqual({
      routes: { "client.profile": "/client/profile/:userId" },
      searchSchemas: {},
    });
  });

  it("merges an inline mount before default-imported clientUrls in registration order", () => {
    const dir = createTempDir();
    writeClientUrls(dir);
    const routerPath = writeMultiMountRouter(dir, "server-first");

    expect(buildCombinedRouteMapForRouterFile(routerPath)).toEqual({
      routes: {
        server: "/server/:slug",
        conflict: "/client-conflict",
        client: "/client/:id",
      },
      searchSchemas: {
        server: { q: "string" },
        conflict: { client: "boolean?" },
        client: { tab: "string?" },
      },
    });
  });

  it("lets a later inline mount override default-imported clientUrls", () => {
    const dir = createTempDir();
    writeClientUrls(dir);
    const routerPath = writeMultiMountRouter(dir, "client-first");

    expect(buildCombinedRouteMapForRouterFile(routerPath)).toEqual({
      routes: {
        client: "/client/:id",
        conflict: "/server-conflict",
        server: "/server/:slug",
      },
      searchSchemas: {
        client: { tab: "string?" },
        server: { q: "string" },
      },
    });
  });

  it("merges createRouter({ urls }) before mounts and applies basename once", () => {
    const dir = createTempDir();
    writeClientUrls(dir);
    const routerPath = join(dir, "router.tsx");
    writeFileSync(
      routerPath,
      `import { createRouter } from "@rangojs/router";
import appUrls from "./app.urls.js";
export const router = createRouter({
  basename: "/base",
  urls: ${inlineServerUrls},
}).routes(appUrls);
`,
    );

    const result = buildCombinedRouteMapForRouterFile(routerPath);
    expect(result.routes).toMatchObject({
      server: "/base/server/:slug",
      client: "/base/client/:id",
      conflict: "/base/client-conflict",
    });
    expect(result.searchSchemas.conflict).toEqual({ client: "boolean?" });
  });

  it("keeps a runtime-complete generated map unchanged", () => {
    const dir = createTempDir();
    writeClientUrls(dir);
    const routerPath = writeMultiMountRouter(dir, "server-first");
    const genPath = join(dir, "router.named-routes.gen.ts");
    const runtimeSource = generateRouteTypesSource(
      {
        server: "/server/:slug",
        conflict: "/client-conflict",
        client: "/client/:id",
      },
      {
        server: { q: "string" },
        conflict: { client: "boolean?" },
        client: { tab: "string?" },
      },
    );
    writeFileSync(genPath, runtimeSource);

    writeCombinedRouteTypes(dir, [routerPath]);

    expect(readFileSync(genPath, "utf-8")).toBe(runtimeSource);
  });

  it("detects unresolvable includes in every direct mount", () => {
    const dir = createTempDir();
    writeClientUrls(dir);
    const routerPath = join(dir, "router.tsx");
    writeFileSync(
      routerPath,
      `import { createRouter } from "@rangojs/router";
import appUrls from "./app.urls.js";
export const router = createRouter()
  .routes(({ include }) => [
    include("/broken", createBrokenRoutes(), { name: "broken" }),
  ])
  .routes(appUrls);
`,
    );

    expect(detectUnresolvableIncludes(routerPath)).toMatchObject([
      {
        pathPrefix: "/broken",
        namePrefix: "broken",
        reason: "factory-call",
      },
    ]);
  });
});
