import { describe, it, expect, vi } from "vitest";
import {
  exposeInternalIds,
  type ExposeInternalIdsApi,
} from "../expose-internal-ids.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createPlugin(opts?: { forceBuild?: boolean }) {
  const plugin = exposeInternalIds(opts);
  return plugin as typeof plugin & {
    api: ExposeInternalIdsApi;
    configResolved: (config: any) => void;
    resolveId: (this: any, id: string, importer?: string) => any;
    load: (this: any, id: string) => any;
    transform: (this: any, code: string, id: string) => any;
  };
}

const ROOT = "/project";
const FILE_ID = "/project/src/urls.tsx";

function initDev(plugin: ReturnType<typeof createPlugin>) {
  plugin.configResolved({ command: "serve", root: ROOT });
}

function rscCtx() {
  return { environment: { name: "rsc" }, warn: vi.fn() };
}

function clientCtx() {
  return { environment: { name: "client" }, warn: vi.fn() };
}

/**
 * Extract `import { __sh_xxx } from "virtual:handler-extract:..."` entries
 * from transformed code.
 */
function extractVirtualImports(
  code: string,
): Array<{ exportName: string; specifier: string }> {
  const results: Array<{ exportName: string; specifier: string }> = [];
  const re =
    /import\s*\{\s*(__sh_\w+)\s*\}\s*from\s*"(virtual:handler-extract:[^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    results.push({ exportName: m[1], specifier: m[2] });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Test sources
// ---------------------------------------------------------------------------

const INLINE_SOURCE = `import { createStaticHandler } from "@rangojs/router";
layout(createStaticHandler(() => <nav />));
`;

const EXPORT_SOURCE = `import { createStaticHandler } from "@rangojs/router";
export const Nav = createStaticHandler(() => <nav />);
`;

const MIXED_SOURCE = `import { createStaticHandler } from "@rangojs/router";
export const Nav = createStaticHandler(() => <nav />);
layout(createStaticHandler(() => <sidebar />));
`;

const SAME_LINE_SOURCE = `import { createStaticHandler } from "@rangojs/router";
layout(createStaticHandler(() => <a />), createStaticHandler(() => <b />));
`;

const PRERENDER_INLINE_SOURCE = `import { createPrerenderHandler } from "@rangojs/router";
path("/about", createPrerenderHandler(() => <div>About</div>));
`;

const PRERENDER_EXPORT_SOURCE = `import { createPrerenderHandler } from "@rangojs/router";
export const AboutPage = createPrerenderHandler(() => <div>About</div>);
`;

const PRERENDER_MIXED_SOURCE = `import { createPrerenderHandler } from "@rangojs/router";
export const AboutPage = createPrerenderHandler(() => <main />);
path("/inline", createPrerenderHandler(() => <aside />));
`;

const PRERENDER_INLINE_WHITESPACE_SOURCE = `import { createPrerenderHandler } from "@rangojs/router";
path("/about", createPrerenderHandler
(() => <div>About</div>));
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("exposeInternalIds - inline static handler integration", () => {
  // -----------------------------------------------------------------------
  // Full round-trip: RSC dev mode
  // -----------------------------------------------------------------------

  describe("full round-trip: RSC dev mode", () => {
    it("transforms inline call -> resolves virtual -> loads -> injects $$id", () => {
      const plugin = createPlugin();
      initDev(plugin);

      // Step 1: Transform source with inline call in RSC env
      const r1 = plugin.transform.call(rscCtx(), INLINE_SOURCE, FILE_ID);
      expect(r1).toBeDefined();

      // Should have a virtual module import
      const vImports = extractVirtualImports(r1.code);
      expect(vImports).toHaveLength(1);
      const { exportName, specifier } = vImports[0];
      expect(exportName).toMatch(/^__sh_[0-9a-f]{8}$/);

      // The inline call should be replaced with the import name
      expect(r1.code).toContain(`layout(${exportName})`);
      expect(r1.code).not.toContain("createStaticHandler(() => <nav />)");

      // Step 2: resolveId adds \0 prefix
      const resolved = plugin.resolveId.call({}, specifier, FILE_ID);
      expect(resolved).toBe("\0" + specifier);

      // Step 3: load synthesises the virtual module
      const loaded = plugin.load.call({}, resolved);
      expect(loaded).toBeDefined();
      expect(loaded).toContain(`export const ${exportName}`);
      expect(loaded).toContain("createStaticHandler");
      expect(loaded).toContain("@rangojs/router");

      // Step 4: transform virtual module in RSC injects $$id
      const r2 = plugin.transform.call(rscCtx(), loaded, resolved);
      expect(r2).toBeDefined();
      expect(r2.code).toContain("$$id");
      expect(r2.code).toContain(`${exportName}.$$id`);
    });
  });

  // -----------------------------------------------------------------------
  // Full round-trip: non-RSC (client/SSR)
  // -----------------------------------------------------------------------

  describe("full round-trip: non-RSC (client/SSR)", () => {
    it("replaces virtual module with stub in client env", () => {
      const plugin = createPlugin();
      initDev(plugin);

      // Populate virtual registry via RSC transform
      const r1 = plugin.transform.call(rscCtx(), INLINE_SOURCE, FILE_ID);
      const { exportName, specifier } = extractVirtualImports(r1.code)[0];

      const resolved = plugin.resolveId.call({}, specifier, FILE_ID);
      const loaded = plugin.load.call({}, resolved);

      // Transform virtual module in client env -> stub
      const r2 = plugin.transform.call(clientCtx(), loaded, resolved);
      expect(r2).toBeDefined();
      expect(r2.code).toContain("__brand");
      expect(r2.code).toContain('"staticHandler"');
      expect(r2.code).toContain("$$id");
      // No createStaticHandler call remains
      expect(r2.code).not.toContain("createStaticHandler(");
    });
  });

  // -----------------------------------------------------------------------
  // Mixed files (export const + inline)
  // -----------------------------------------------------------------------

  describe("mixed files (export const + inline)", () => {
    it("extracts inline, leaves export const, both get $$id in RSC", () => {
      const plugin = createPlugin();
      initDev(plugin);

      // Transform mixed source in RSC
      const r1 = plugin.transform.call(rscCtx(), MIXED_SOURCE, FILE_ID);
      expect(r1).toBeDefined();

      // Inline call extracted to virtual module
      const vImports = extractVirtualImports(r1.code);
      expect(vImports).toHaveLength(1);

      // Export const Nav stays in the original file with $$id injected
      expect(r1.code).toContain("export const Nav = createStaticHandler");
      expect(r1.code).toContain("Nav.$$id");

      // Inline call replaced with import name
      expect(r1.code).toContain(`layout(${vImports[0].exportName})`);
      expect(r1.code).not.toContain("createStaticHandler(() => <sidebar />)");

      // Virtual module also gets $$id in RSC
      const resolved = plugin.resolveId.call(
        {},
        vImports[0].specifier,
        FILE_ID,
      );
      const loaded = plugin.load.call({}, resolved);
      const r2 = plugin.transform.call(rscCtx(), loaded, resolved);
      expect(r2).toBeDefined();
      expect(r2.code).toContain(`${vImports[0].exportName}.$$id`);
    });
  });

  // -----------------------------------------------------------------------
  // Module tracking (RSC build mode)
  // -----------------------------------------------------------------------

  describe("module tracking (RSC build mode)", () => {
    it("populates staticHandlerModules for export const patterns", () => {
      const plugin = createPlugin({ forceBuild: true });
      initDev(plugin); // forceBuild overrides command

      plugin.transform.call(rscCtx(), EXPORT_SOURCE, FILE_ID);

      expect(plugin.api.staticHandlerModules.get(FILE_ID)).toEqual(["Nav"]);
    });

    it("tracks virtual module exports in build mode", () => {
      const plugin = createPlugin({ forceBuild: true });
      initDev(plugin);

      // Populate registry via RSC transform
      const r1 = plugin.transform.call(rscCtx(), INLINE_SOURCE, FILE_ID);
      const { exportName, specifier } = extractVirtualImports(r1.code)[0];

      const resolved = plugin.resolveId.call({}, specifier, FILE_ID);
      const loaded = plugin.load.call({}, resolved);

      // Transform virtual module in RSC build mode
      plugin.transform.call(rscCtx(), loaded, resolved);

      expect(plugin.api.staticHandlerModules.get(resolved)).toEqual([
        exportName,
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // Virtual module import resolution
  // -----------------------------------------------------------------------

  describe("virtual module import resolution", () => {
    it("resolves imports from virtual modules against original file", () => {
      const plugin = createPlugin();
      initDev(plugin);

      // Populate registry
      const r1 = plugin.transform.call(rscCtx(), INLINE_SOURCE, FILE_ID);
      const { specifier } = extractVirtualImports(r1.code)[0];
      const resolved = plugin.resolveId.call({}, specifier, FILE_ID);

      // Resolve an import from within the virtual module
      const ctx = {
        resolve: vi
          .fn()
          .mockResolvedValue({ id: "/project/src/components/Nav.tsx" }),
      };
      plugin.resolveId.call(ctx, "@rangojs/router", resolved);

      expect(ctx.resolve).toHaveBeenCalledWith(
        "@rangojs/router",
        FILE_ID,
        { skipSelf: true },
      );
    });
  });

  // -----------------------------------------------------------------------
  // Server-only import eviction (node:fs in Cloudflare)
  // -----------------------------------------------------------------------

  describe("server-only import eviction", () => {
    it("virtual module stub drops node:fs import (inline call path)", () => {
      const plugin = createPlugin();
      initDev(plugin);

      const source = `import { createStaticHandler } from "@rangojs/router";
import { readFileSync } from "node:fs";
layout(createStaticHandler(() => {
  const data = readFileSync("data.json", "utf-8");
  return <pre>{data}</pre>;
}));
`;

      // RSC transform populates virtual registry
      const r1 = plugin.transform.call(rscCtx(), source, FILE_ID);
      const { exportName, specifier } = extractVirtualImports(r1.code)[0];

      const resolved = plugin.resolveId.call({}, specifier, FILE_ID);
      const loaded = plugin.load.call({}, resolved);

      // Virtual module should contain node:fs (needed for RSC build)
      expect(loaded).toContain("node:fs");
      expect(loaded).toContain("readFileSync");

      // Client transform should produce stub WITHOUT node:fs
      const r2 = plugin.transform.call(clientCtx(), loaded, resolved);
      expect(r2).toBeDefined();
      expect(r2.code).not.toContain("node:fs");
      expect(r2.code).not.toContain("readFileSync");
      expect(r2.code).toContain("__brand");
      expect(r2.code).toContain('"staticHandler"');
    });

    it("whole-file stub drops node:fs import (export const path)", () => {
      const plugin = createPlugin();
      initDev(plugin);

      const source = `import { createStaticHandler } from "@rangojs/router";
import { readFileSync } from "node:fs";
export const Nav = createStaticHandler(() => {
  const data = readFileSync("data.json", "utf-8");
  return <pre>{data}</pre>;
});
`;

      // Client transform should produce stub WITHOUT node:fs
      const r = plugin.transform.call(clientCtx(), source, FILE_ID);
      expect(r).toBeDefined();
      expect(r.code).not.toContain("node:fs");
      expect(r.code).not.toContain("readFileSync");
      expect(r.code).toContain("__brand");
      expect(r.code).toContain('"staticHandler"');
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    it("no relevant imports -> transform returns undefined", () => {
      const plugin = createPlugin();
      initDev(plugin);

      const code = `import { route } from "@rangojs/router";\nroute("/", handler);`;
      const result = plugin.transform.call(rscCtx(), code, FILE_ID);
      expect(result).toBeUndefined();
    });

    it("only export const -> no virtual modules, $$id injected in RSC", () => {
      const plugin = createPlugin();
      initDev(plugin);

      const result = plugin.transform.call(rscCtx(), EXPORT_SOURCE, FILE_ID);
      expect(result).toBeDefined();

      // No virtual module imports
      expect(extractVirtualImports(result.code)).toHaveLength(0);

      // $$id injected
      expect(result.code).toContain("Nav.$$id");
    });

    it("same-line collisions -> distinct virtual modules", () => {
      const plugin = createPlugin();
      initDev(plugin);

      const result = plugin.transform.call(
        rscCtx(),
        SAME_LINE_SOURCE,
        FILE_ID,
      );
      expect(result).toBeDefined();

      const vImports = extractVirtualImports(result.code);
      expect(vImports).toHaveLength(2);

      // Different export names
      expect(vImports[0].exportName).not.toBe(vImports[1].exportName);
      // Different specifiers
      expect(vImports[0].specifier).not.toBe(vImports[1].specifier);
    });

    it("extracts inline call when fn name and paren are split by newline", () => {
      const plugin = createPlugin();
      initDev(plugin);

      const result = plugin.transform.call(
        rscCtx(),
        PRERENDER_INLINE_WHITESPACE_SOURCE,
        FILE_ID,
      );
      expect(result).toBeDefined();

      const vImports = extractVirtualImports(result.code);
      expect(vImports).toHaveLength(1);
      expect(result.code).toContain(`path("/about", ${vImports[0].exportName})`);
      expect(result.code).not.toContain("createPrerenderHandler\n(");
    });

    it("load returns null for unregistered virtual ID", () => {
      const plugin = createPlugin();
      initDev(plugin);

      const result = plugin.load.call(
        {},
        "\0virtual:handler-extract:nonexistent:99",
      );
      expect(result).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Inline createPrerenderHandler integration
// ---------------------------------------------------------------------------

describe("exposeInternalIds - inline prerender handler integration", () => {
  describe("full round-trip: RSC dev mode", () => {
    it("transforms inline createPrerenderHandler -> virtual -> $$id", () => {
      const plugin = createPlugin();
      initDev(plugin);

      // Step 1: Transform source with inline call in RSC env
      const r1 = plugin.transform.call(rscCtx(), PRERENDER_INLINE_SOURCE, FILE_ID);
      expect(r1).toBeDefined();

      // Should have a virtual module import
      const vImports = extractVirtualImports(r1.code);
      expect(vImports).toHaveLength(1);
      const { exportName, specifier } = vImports[0];
      expect(exportName).toMatch(/^__sh_[0-9a-f]{8}$/);

      // The inline call should be replaced with the import name
      expect(r1.code).toContain(`path("/about", ${exportName})`);
      expect(r1.code).not.toContain("createPrerenderHandler(() =>");

      // Step 2: resolveId adds \0 prefix
      const resolved = plugin.resolveId.call({}, specifier, FILE_ID);
      expect(resolved).toBe("\0" + specifier);

      // Step 3: load synthesises the virtual module
      const loaded = plugin.load.call({}, resolved);
      expect(loaded).toBeDefined();
      expect(loaded).toContain(`export const ${exportName}`);
      expect(loaded).toContain("createPrerenderHandler");
      expect(loaded).toContain("@rangojs/router");

      // Step 4: transform virtual module in RSC injects $$id
      const r2 = plugin.transform.call(rscCtx(), loaded, resolved);
      expect(r2).toBeDefined();
      expect(r2.code).toContain("$$id");
      expect(r2.code).toContain(`${exportName}.$$id`);
    });
  });

  describe("full round-trip: non-RSC (client/SSR)", () => {
    it("replaces virtual prerender module with stub in client env", () => {
      const plugin = createPlugin();
      initDev(plugin);

      // Populate virtual registry via RSC transform
      const r1 = plugin.transform.call(rscCtx(), PRERENDER_INLINE_SOURCE, FILE_ID);
      const { exportName, specifier } = extractVirtualImports(r1.code)[0];

      const resolved = plugin.resolveId.call({}, specifier, FILE_ID);
      const loaded = plugin.load.call({}, resolved);

      // Transform virtual module in client env -> stub
      const r2 = plugin.transform.call(clientCtx(), loaded, resolved);
      expect(r2).toBeDefined();
      expect(r2.code).toContain("__brand");
      expect(r2.code).toContain('"prerenderHandler"');
      expect(r2.code).toContain("$$id");
      // No createPrerenderHandler call remains
      expect(r2.code).not.toContain("createPrerenderHandler(");
    });
  });

  describe("mixed files (export const + inline)", () => {
    it("extracts inline, leaves export const, both get $$id in RSC", () => {
      const plugin = createPlugin();
      initDev(plugin);

      // Transform mixed source in RSC
      const r1 = plugin.transform.call(rscCtx(), PRERENDER_MIXED_SOURCE, FILE_ID);
      expect(r1).toBeDefined();

      // Inline call extracted to virtual module
      const vImports = extractVirtualImports(r1.code);
      expect(vImports).toHaveLength(1);

      // Export const stays in the original file with $$id injected
      expect(r1.code).toContain("export const AboutPage = createPrerenderHandler");
      expect(r1.code).toContain("AboutPage.$$id");

      // Inline call replaced with import name
      expect(r1.code).toContain(`path("/inline", ${vImports[0].exportName})`);
      expect(r1.code).not.toContain("createPrerenderHandler(() => <aside />)");
    });
  });

  describe("module tracking (RSC build mode)", () => {
    it("populates prerenderHandlerModules for export const patterns", () => {
      const plugin = createPlugin({ forceBuild: true });
      initDev(plugin);

      plugin.transform.call(rscCtx(), PRERENDER_EXPORT_SOURCE, FILE_ID);

      expect(plugin.api.prerenderHandlerModules.get(FILE_ID)).toEqual(["AboutPage"]);
    });
  });
});
