import { describe, it, expect, vi } from "vitest";
import { exposeInternalIds } from "../plugins/expose-internal-ids.js";
import { exposeRouterId } from "../plugins/expose-internal-ids.js";

// Dogfood the public Vite-plugin transforms (the consumer-facing build surface)
// for three Batch-E expose-ids fixes.

const ROOT = "/project";

function createInternal(opts?: { forceBuild?: boolean }) {
  const plugin = exposeInternalIds(opts) as any;
  plugin.configResolved({ command: "serve", root: ROOT });
  return plugin;
}
function rscCtx() {
  return { environment: { name: "rsc" }, warn: vi.fn() };
}
function clientCtx() {
  return { environment: { name: "client" }, warn: vi.fn() };
}

function createRouterPlugin(root = ROOT) {
  const plugin = exposeRouterId() as any;
  plugin.configResolved({ root });
  const ctx = { warn: vi.fn() };
  return {
    transform: (code: string, id: string) =>
      plugin.transform.call(ctx, code, id),
  };
}

// ---------------------------------------------------------------------------
// E3: createRouter $$id idempotency guard must not be an over-broad substring
// ---------------------------------------------------------------------------

describe("exposeRouterId (E3): $$id substring in a user value must not drop wiring", () => {
  it("wires a createRouter whose args contain the literal text $$id in a string", () => {
    const plugin = createRouterPlugin();
    const code = `import { createRouter } from "@rangojs/router";
export const router = createRouter({ routes: [], meta: { note: "see $$id docs" } });
`;
    const result = plugin.transform(code, "/project/src/router.tsx");
    expect(result).toBeTruthy();
    // Named-route wiring must be injected despite the "$$id" substring.
    expect(result.code).toMatch(/\$\$routeNames:\s*__rsc_rn/);
    expect(result.code).toContain("see $$id docs");
    expect(result.code).toMatch(
      /import\s*\{\s*NamedRoutes\s+as\s+__rsc_rn\s*\}/,
    );
  });

  it("wires a createRouter whose args contain $$id in a comment", () => {
    const plugin = createRouterPlugin();
    const code = `import { createRouter } from "@rangojs/router";
export const router = createRouter({ /* $$id later */ routes: [] });
`;
    const result = plugin.transform(code, "/project/src/router.tsx");
    expect(result).toBeTruthy();
    expect(result.code).toMatch(/\$\$routeNames:\s*__rsc_rn/);
  });

  it("skips a call already injected with $$routeNames (idempotent)", () => {
    const plugin = createRouterPlugin();
    // Simulate an already-transformed call carrying the injected marker.
    const code = `import { createRouter } from "@rangojs/router";
import { NamedRoutes as __rsc_rn } from "./router.named-routes.gen.js";
export const router = createRouter({ $$id: "deadbeef", $$sourceFile: "x", $$routeNames: __rsc_rn, routes: [] });
`;
    const result = plugin.transform(code, "/project/src/router.tsx");
    // No further injection: transform returns null (nothing changed).
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// E4: loader-only client stubs — aliases must share exportNames[0]'s id
// ---------------------------------------------------------------------------

describe("exposeInternalIds (E4): aliased loader exports share one id on client + server", () => {
  it("client stub: alias B reuses the primary export's id, not its own", () => {
    const plugin = createInternal();
    const code = `import { createLoader } from "@rangojs/router";
const L = createLoader(async () => ({ ok: true }));
export { L as A, L as B };
`;
    const result = plugin.transform.call(
      clientCtx(),
      code,
      "/project/src/loaders.ts",
    );
    expect(result).toBeTruthy();
    // Primary export carries the loader stub with an id.
    const idMatch = result.code.match(
      /export const A = \{ __brand: "loader", \$\$id: "([^"]+)" \}/,
    );
    expect(idMatch).toBeTruthy();
    // Alias B aliases the primary, NOT an independent stub with its own id.
    expect(result.code).toContain("export const B = A;");
    expect(result.code).not.toMatch(/export const B = \{ __brand/);
  });

  it("client alias id matches the single id the server registers (exportNames[0])", () => {
    const FILE = "/project/src/loaders.ts";
    const code = `import { createLoader } from "@rangojs/router";
const L = createLoader(async () => ({ ok: true }));
export { L as A, L as B };
`;

    // Client side: extract the primary stub id.
    const clientPlugin = createInternal();
    const clientResult = clientPlugin.transform.call(clientCtx(), code, FILE);
    const clientId = clientResult.code.match(
      /export const A = \{ __brand: "loader", \$\$id: "([^"]+)" \}/,
    )?.[1];
    expect(clientId).toBeTruthy();

    // Server side: the RSC transform injects the loader id as a call arg /
    // property assignment keyed on the primary export name.
    const serverPlugin = createInternal();
    const serverResult = serverPlugin.transform.call(rscCtx(), code, FILE);
    expect(serverResult).toBeTruthy();
    // The same id appears on the server output.
    expect(serverResult.code).toContain(`"${clientId}"`);
  });
});

// ---------------------------------------------------------------------------
// E5: createHandle with a comment-prefixed (comment-only) arg list
// ---------------------------------------------------------------------------

describe("exposeInternalIds (E5): comment-only createHandle args transform correctly", () => {
  it('emits `undefined, "id"` (not `, "id"`) for a comment-only arg list', () => {
    const plugin = createInternal();
    const code = `import { createHandle } from "@rangojs/router";
export const H = createHandle(/* meta */);
`;
    const result = plugin.transform.call(rscCtx(), code, "/project/src/h.ts");
    expect(result).toBeTruthy();
    // Must NOT emit an elided first arg (`createHandle(/* meta */, "id")`),
    // which is a syntax error. Zero real args -> `undefined, "id"`.
    expect(result.code).toMatch(
      /createHandle\(\/\* meta \*\/undefined, "[^"]+"\)/,
    );
    expect(result.code).not.toMatch(/createHandle\(\/\* meta \*\/, "/);
  });

  it('emits `, "id"` for a real first argument', () => {
    const plugin = createInternal();
    const code = `import { createHandle } from "@rangojs/router";
export const H = createHandle(() => []);
`;
    const result = plugin.transform.call(rscCtx(), code, "/project/src/h.ts");
    expect(result).toBeTruthy();
    expect(result.code).toMatch(/=> \[\], "[^"]+"\)/);
  });
});
