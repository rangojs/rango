import { describe, it, expect } from "vitest";
import { exposeRouterId } from "../plugins/expose-internal-ids.js";

function createPlugin() {
  const plugin = exposeRouterId();
  return plugin as typeof plugin & {
    configResolved: (config: any) => void;
    transform: (code: string, id: string) => any;
  };
}

// Bind a `this` carrying a `warn` recorder so transform-hook warnings surface
// to assertions. The plugin's transform is invoked as a method on this object.
function initPlugin(root = "/project") {
  const plugin = createPlugin();
  plugin.configResolved({ root });
  const warnings: string[] = [];
  const ctx = {
    warn: (msg: string) => {
      warnings.push(msg);
    },
  };
  const rawTransform = plugin.transform;
  const wrapped = plugin as typeof plugin & { warnings: string[] };
  wrapped.warnings = warnings;
  wrapped.transform = (code: string, id: string) =>
    rawTransform.call(ctx, code, id);
  return wrapped;
}

describe("exposeRouterId", () => {
  // ---- Basic injection ----

  it("injects $$id, $$sourceFile and $$routeNames into createRouter({...})", () => {
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
    // $$sourceFile should be the absolute path
    expect(result.code).toMatch(
      /\$\$sourceFile:\s*"\/project\/src\/router\.tsx"/,
    );
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

  it("does not inject for a createRouter() that only appears in a comment", () => {
    // Regression: a module that imports createRouter for a real value (e.g. an
    // option factory) but whose only createRouter(...) call-shaped text is in a
    // JSDoc example must NOT get a `$$id` or a `.named-routes.gen` import — that
    // gen file does not exist next to such a module and the build would fail.
    const plugin = initPlugin();
    const code = `import { createRouter } from "@rangojs/router";
/**
 * Usage:
 *   export const router = createRouter({ tracing: createCloudflareTracing() });
 */
export function helper() {
  return 1;
}
`;
    const result = plugin.transform(code, "/project/src/cloudflare/tracing.ts");
    expect(result).toBeNull();
  });

  it("injects into the real call but ignores a createRouter() in a comment/string", () => {
    const plugin = initPlugin();
    const code = `import { createRouter } from "@rangojs/router";
// example: createRouter({ a: 1 })
const note = "see createRouter({ b: 2 })";
export const router = createRouter({ routes: [] });
`;
    const result = plugin.transform(code, "/project/src/router.tsx");
    expect(result).toBeDefined();
    // Exactly one $$id injection — the real call, not the comment or string.
    const ids = result.code.match(/\$\$id:/g) ?? [];
    expect(ids).toHaveLength(1);
    // The injected id sits on the real call's config object.
    expect(result.code).toMatch(/createRouter\(\{\s*\$\$id:[^}]*routes:/);
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

  // B2: a nested generic argument must not defeat the generic-skip scan.
  // The old `<[^>]*>` regex stops at the first `>`, never reaching `(`.
  it("injects into createRouter<Config<Env>>() with a nested generic", () => {
    const plugin = initPlugin();
    const code = `import { createRouter } from "@rangojs/router";
export const router = createRouter<Config<Env>>({ routes: [] });
`;
    const result = plugin.transform(code, "/project/src/router.tsx");
    expect(result).toBeDefined();
    const idMatch = result.code.match(/\$\$id:\s*"([0-9a-f]{8})"/);
    expect(idMatch).toBeDefined();
    expect(result.code).toMatch(/\$\$routeNames:\s*__rsc_rn/);
    // Exactly one injection on the real call.
    expect((result.code.match(/\$\$id:/g) ?? []).length).toBe(1);
  });

  it("injects into createRouter<A<B<C>>>() with a doubly-nested generic", () => {
    const plugin = initPlugin();
    const code = `import { createRouter } from "@rangojs/router";
export const router = createRouter<A<B<C>>>({ routes: [] });
`;
    const result = plugin.transform(code, "/project/src/router.tsx");
    expect(result).toBeDefined();
    const idMatch = result.code.match(/\$\$id:\s*"([0-9a-f]{8})"/);
    expect(idMatch).toBeDefined();
  });

  // ---- Unsupported / comment-prefixed argument shapes (B1) ----

  // A leading comment before the config object must not defeat injection.
  it("injects into createRouter(/* comment */ {...})", () => {
    const plugin = initPlugin();
    const code = `import { createRouter } from "@rangojs/router";
export const router = createRouter(/* opts */ { routes: [] });
`;
    const result = plugin.transform(code, "/project/src/router.tsx");
    expect(result).toBeDefined();
    const idMatch = result.code.match(/\$\$id:\s*"([0-9a-f]{8})"/);
    expect(idMatch).toBeDefined();
    expect(result.code).toMatch(/\$\$routeNames:\s*__rsc_rn/);
    expect((result.code.match(/\$\$id:/g) ?? []).length).toBe(1);
  });

  it("injects into createRouter(// line comment\\n {...})", () => {
    const plugin = initPlugin();
    const code = `import { createRouter } from "@rangojs/router";
export const router = createRouter(
  // options
  { routes: [] },
);
`;
    const result = plugin.transform(code, "/project/src/router.tsx");
    expect(result).toBeDefined();
    expect(result.code.match(/\$\$id:/g) ?? []).toHaveLength(1);
  });

  // A bare identifier argument is an unsupported shape: no $$id can be
  // injected. The transform must emit a warning and must NOT prepend a dead
  // named-routes.gen import (the gen file is unused and may not exist).
  it("warns and does not inject for createRouter(configVar) — bare identifier", () => {
    const plugin = initPlugin();
    const code = `import { createRouter } from "@rangojs/router";
const cfg = { routes: [] };
export const router = createRouter(cfg);
`;
    const result = plugin.transform(code, "/project/src/router.tsx");
    // No injection happened, so no transformed output.
    expect(result).toBeNull();
    // A warning was surfaced via the plugin warn channel.
    expect(plugin.warnings.length).toBeGreaterThan(0);
    expect(plugin.warnings.join("\n")).toMatch(/createRouter/);
  });

  // Even when one call is injectable and another is a bare identifier, the
  // dead import must only be prepended because a real injection occurred, and
  // the unsupported call must still warn.
  it("injects the supported call but warns on a sibling createRouter(cfg)", () => {
    const plugin = initPlugin();
    const code = `import { createRouter } from "@rangojs/router";
const cfg = { routes: [] };
export const a = createRouter({ id: "a" });
export const b = createRouter(cfg);
`;
    const result = plugin.transform(code, "/project/src/router.tsx");
    expect(result).toBeDefined();
    // Exactly one injection (the object-literal call), not the identifier one.
    expect(result.code.match(/\$\$id:/g) ?? []).toHaveLength(1);
    // Import prepended because a real injection occurred.
    expect(result.code).toMatch(
      /import\s*\{\s*NamedRoutes\s+as\s+__rsc_rn\s*\}/,
    );
    // The bare-identifier call still warns.
    expect(plugin.warnings.join("\n")).toMatch(/createRouter/);
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
