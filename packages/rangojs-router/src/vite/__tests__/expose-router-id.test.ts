import { describe, it, expect } from "vitest";
import { exposeRouterId } from "../plugins/expose-internal-ids.js";

function createPlugin() {
  const plugin = exposeRouterId();
  return plugin as typeof plugin & {
    configResolved: (config: any) => void;
    transform: (code: string, id: string) => any;
  };
}

function initPlugin(root = "/project") {
  const plugin = createPlugin();
  plugin.configResolved({ root });
  return plugin;
}

describe("exposeRouterId", () => {
  // ---- Basic injection ----

  it("injects $$id and $$routeNames into createRouter({...})", () => {
    const plugin = initPlugin();
    const code = `import { createRouter } from "@rangojs/router";
export const router = createRouter({ routes: [] });
`;
    const result = plugin.transform(code, "/project/src/router.tsx");
    expect(result).toBeDefined();
    // $$id should be an 8-char hex hash
    const idMatch = result.code.match(/\$\$id:\s*"([^"]+)"/);
    expect(idMatch).toBeDefined();
    expect(idMatch![1]).toMatch(/^[0-9a-f]{8}$/);
    // $$routeNames should reference the imported variable
    expect(result.code).toMatch(/\$\$routeNames:\s*__rsc_rn/);
    // Should import named-routes.gen with correct filename
    expect(result.code).toMatch(
      /import\s*\{\s*NamedRoutes\s+as\s+__rsc_rn\s*\}\s*from\s*"\.\/router\.named-routes\.gen\.js"/,
    );
  });

  it("injects into createRouter() with empty args (no config object)", () => {
    const plugin = initPlugin();
    const code = `import { createRouter } from "@rangojs/router";
export const router = createRouter();
`;
    const result = plugin.transform(code, "/project/src/router.tsx");
    expect(result).toBeDefined();
    // Should wrap empty args with a config object containing $$id and $$routeNames
    const idMatch = result.code.match(/\$\$id:\s*"([0-9a-f]{8})"/);
    expect(idMatch).toBeDefined();
    expect(result.code).toMatch(/createRouter\(\{\s*\$\$id:/);
    expect(result.code).toMatch(/\$\$routeNames:\s*__rsc_rn/);
  });

  it("injects when createRouter is imported with alias", () => {
    const plugin = initPlugin();
    const code = `import { createRouter as cr } from "@rangojs/router";
const router = cr({});
`;
    const result = plugin.transform(code, "/project/src/router.tsx");
    expect(result).toBeDefined();
    // Should inject into the aliased cr() call
    const idMatch = result.code.match(/\$\$id:\s*"([0-9a-f]{8})"/);
    expect(idMatch).toBeDefined();
    expect(result.code).toMatch(/\$\$routeNames:\s*__rsc_rn/);
  });

  it("injects when createRouter call is exported via specifier alias", () => {
    const plugin = initPlugin();
    const code = `import { createRouter as cr } from "@rangojs/router";
const routerDef = cr({});
export { routerDef as router };
`;
    const result = plugin.transform(code, "/project/src/router.tsx");
    expect(result).toBeDefined();
    const idMatch = result.code.match(/\$\$id:\s*"([0-9a-f]{8})"/);
    expect(idMatch).toBeDefined();
    expect(result.code).toMatch(/\$\$routeNames:\s*__rsc_rn/);
  });

  // ---- Source filtering ----

  it("returns null when createRouter is not imported from @rangojs/router", () => {
    const plugin = initPlugin();
    const code = `const router = createRouter({});`;
    const result = plugin.transform(code, "/project/src/router.tsx");
    expect(result).toBeNull();
  });

  it("returns null when file doesn't contain createRouter at all", () => {
    const plugin = initPlugin();
    const code = `import { createLoader } from "@rangojs/router";
export const loader = createLoader(() => null);
`;
    const result = plugin.transform(code, "/project/src/loader.ts");
    expect(result).toBeNull();
  });

  it("skips files in node_modules", () => {
    const plugin = initPlugin();
    const code = `import { createRouter } from "@rangojs/router";
export const router = createRouter({});
`;
    const result = plugin.transform(
      code,
      "/project/node_modules/some-lib/router.tsx",
    );
    expect(result).toBeNull();
  });

  it("processes createRouter from @rangojs/router/server subpath", () => {
    const plugin = initPlugin();
    const code = `import { createRouter } from "@rangojs/router/server";
export const router = createRouter({});
`;
    const result = plugin.transform(code, "/project/src/router.tsx");
    expect(result).toBeDefined();
    const idMatch = result.code.match(/\$\$id:\s*"([0-9a-f]{8})"/);
    expect(idMatch).toBeDefined();
  });

  // ---- ID stability ----

  it("produces deterministic $$id for same file and line", () => {
    const plugin = initPlugin();
    const code = `import { createRouter } from "@rangojs/router";
export const router = createRouter({});
`;
    const r1 = plugin.transform(code, "/project/src/router.tsx");
    const r2 = plugin.transform(code, "/project/src/router.tsx");
    // Extract the $$id value from both transforms
    const idMatch1 = r1.code.match(/\$\$id:\s*"([^"]+)"/);
    const idMatch2 = r2.code.match(/\$\$id:\s*"([^"]+)"/);
    expect(idMatch1).toBeDefined();
    expect(idMatch1![1]).toBe(idMatch2![1]);
  });

  it("produces different $$id for different files", () => {
    const plugin = initPlugin();
    const code = `import { createRouter } from "@rangojs/router";
export const router = createRouter({});
`;
    const r1 = plugin.transform(code, "/project/src/router-a.tsx");
    const r2 = plugin.transform(code, "/project/src/router-b.tsx");
    const id1 = r1.code.match(/\$\$id:\s*"([^"]+)"/)?.[1];
    const id2 = r2.code.match(/\$\$id:\s*"([^"]+)"/)?.[1];
    expect(id1).not.toBe(id2);
  });

  // ---- Import generation ----

  it("generates correct named-routes.gen import based on filename", () => {
    const plugin = initPlugin();
    const code = `import { createRouter } from "@rangojs/router";
export const router = createRouter({});
`;
    const result = plugin.transform(code, "/project/src/my-router.tsx");
    expect(result.code).toContain("./my-router.named-routes.gen.js");
  });

  it("generates named-routes import for nested path correctly", () => {
    const plugin = initPlugin();
    const code = `import { createRouter } from "@rangojs/router";
export const router = createRouter({});
`;
    const result = plugin.transform(code, "/project/src/routes/main.ts");
    // Import should reference the gen file relative to the router file
    expect(result.code).toContain("./main.named-routes.gen.js");
  });

  // ---- Idempotency ----

  it("does not double-inject when $$id is already present", () => {
    const plugin = initPlugin();
    const code = `import { createRouter } from "@rangojs/router";
export const router = createRouter({ $$id: "existing" });
`;
    const result = plugin.transform(code, "/project/src/router.tsx");
    // Should return null since $$id is already present
    expect(result).toBeNull();
  });

  // ---- Multiple routers ----

  it("injects into multiple createRouter calls in one file with distinct IDs", () => {
    const plugin = initPlugin();
    const code = `import { createRouter } from "@rangojs/router";
export const adminRouter = createRouter({ id: "admin" });
export const siteRouter = createRouter({ id: "site" });
`;
    const result = plugin.transform(code, "/project/src/router.tsx");
    expect(result).toBeDefined();
    // Both should get $$id injected
    const idMatches = [...result.code.matchAll(/\$\$id:\s*"([0-9a-f]{8})"/g)];
    expect(idMatches).toHaveLength(2);
    // IDs should be distinct (different line numbers produce different hashes)
    expect(idMatches[0][1]).not.toBe(idMatches[1][1]);
  });

  // ---- Generics ----

  it("injects into createRouter<T>() with generic type parameter", () => {
    const plugin = initPlugin();
    const code = `import { createRouter } from "@rangojs/router";
export const router = createRouter<MyRoutes>({ routes: [] });
`;
    const result = plugin.transform(code, "/project/src/router.tsx");
    expect(result).toBeDefined();
    const idMatch = result.code.match(/\$\$id:\s*"([0-9a-f]{8})"/);
    expect(idMatch).toBeDefined();
    expect(result.code).toMatch(/\$\$routeNames:\s*__rsc_rn/);
  });

  // ---- Source map ----

  it("returns a source map", () => {
    const plugin = initPlugin();
    const code = `import { createRouter } from "@rangojs/router";
export const router = createRouter({});
`;
    const result = plugin.transform(code, "/project/src/router.tsx");
    expect(result).toBeDefined();
    expect(result.map).toBeDefined();
  });
});
