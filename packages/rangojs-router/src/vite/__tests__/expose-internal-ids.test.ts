import { describe, it, expect, vi } from "vitest";
import {
  exposeInternalIds,
  type ExposeInternalIdsApi,
} from "../plugins/expose-internal-ids.js";

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

const INLINE_SOURCE = `import { Static } from "@rangojs/router";
layout(Static(() => <nav />));
`;

const EXPORT_SOURCE = `import { Static } from "@rangojs/router";
export const Nav = Static(() => <nav />);
`;

const MIXED_SOURCE = `import { Static } from "@rangojs/router";
export const Nav = Static(() => <nav />);
layout(Static(() => <sidebar />));
`;

const SAME_LINE_SOURCE = `import { Static } from "@rangojs/router";
layout(Static(() => <a />), Static(() => <b />));
`;

const PRERENDER_INLINE_SOURCE = `import { Prerender } from "@rangojs/router";
path("/about", Prerender(() => <div>About</div>));
`;

const PRERENDER_EXPORT_SOURCE = `import { Prerender } from "@rangojs/router";
export const AboutPage = Prerender(() => <div>About</div>);
`;

const PRERENDER_MIXED_SOURCE = `import { Prerender } from "@rangojs/router";
export const AboutPage = Prerender(() => <main />);
path("/inline", Prerender(() => <aside />));
`;

const PRERENDER_INLINE_WHITESPACE_SOURCE = `import { Prerender } from "@rangojs/router";
path("/about", Prerender
(() => <div>About</div>));
`;

const STATIC_ALIAS_INLINE_SOURCE = `import { Static as sh } from "@rangojs/router";
layout(sh(() => <nav />));
`;

const STATIC_ALIAS_EXPORT_SOURCE = `import { Static as sh } from "@rangojs/router";
export const Nav = sh(() => <nav />);
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
      expect(r1.code).not.toContain("Static(() => <nav />)");

      // Step 2: resolveId adds \0 prefix
      const resolved = plugin.resolveId.call({}, specifier, FILE_ID);
      expect(resolved).toBe("\0" + specifier);

      // Step 3: load synthesises the virtual module
      const loaded = plugin.load.call({}, resolved);
      expect(loaded).toBeDefined();
      expect(loaded).toContain(`export const ${exportName}`);
      expect(loaded).toContain("Static");
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
      // No Static call remains
      expect(r2.code).not.toContain("Static(");
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
      expect(r1.code).toContain("export const Nav = Static");
      expect(r1.code).toContain("Nav.$$id");

      // Inline call replaced with import name
      expect(r1.code).toContain(`layout(${vImports[0].exportName})`);
      expect(r1.code).not.toContain("Static(() => <sidebar />)");

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

      expect(ctx.resolve).toHaveBeenCalledWith("@rangojs/router", FILE_ID, {
        skipSelf: true,
      });
    });
  });

  // -----------------------------------------------------------------------
  // Server-only import eviction (node:fs in Cloudflare)
  // -----------------------------------------------------------------------

  describe("server-only import eviction", () => {
    it("virtual module stub drops node:fs import (inline call path)", () => {
      const plugin = createPlugin();
      initDev(plugin);

      const source = `import { Static } from "@rangojs/router";
import { readFileSync } from "node:fs";
layout(Static(() => {
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

      const source = `import { Static } from "@rangojs/router";
import { readFileSync } from "node:fs";
export const Nav = Static(() => {
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

      const result = plugin.transform.call(rscCtx(), SAME_LINE_SOURCE, FILE_ID);
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
      expect(result.code).toContain(
        `path("/about", ${vImports[0].exportName})`,
      );
      expect(result.code).not.toContain("Prerender\n(");
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

    it("extracts inline call when Static is imported with alias", () => {
      const plugin = createPlugin();
      initDev(plugin);

      const result = plugin.transform.call(
        rscCtx(),
        STATIC_ALIAS_INLINE_SOURCE,
        FILE_ID,
      );
      expect(result).toBeDefined();

      const vImports = extractVirtualImports(result.code);
      expect(vImports).toHaveLength(1);
      expect(result.code).toContain(`layout(${vImports[0].exportName})`);
    });

    it("injects $$id for export const alias call", () => {
      const plugin = createPlugin();
      initDev(plugin);

      const result = plugin.transform.call(
        rscCtx(),
        STATIC_ALIAS_EXPORT_SOURCE,
        FILE_ID,
      );
      expect(result).toBeDefined();
      expect(result.code).toContain("Nav.$$id");
    });
  });
});

// ---------------------------------------------------------------------------
// Inline Prerender integration
// ---------------------------------------------------------------------------

describe("exposeInternalIds - inline prerender handler integration", () => {
  describe("full round-trip: RSC dev mode", () => {
    it("transforms inline Prerender -> virtual -> $$id", () => {
      const plugin = createPlugin();
      initDev(plugin);

      // Step 1: Transform source with inline call in RSC env
      const r1 = plugin.transform.call(
        rscCtx(),
        PRERENDER_INLINE_SOURCE,
        FILE_ID,
      );
      expect(r1).toBeDefined();

      // Should have a virtual module import
      const vImports = extractVirtualImports(r1.code);
      expect(vImports).toHaveLength(1);
      const { exportName, specifier } = vImports[0];
      expect(exportName).toMatch(/^__sh_[0-9a-f]{8}$/);

      // The inline call should be replaced with the import name
      expect(r1.code).toContain(`path("/about", ${exportName})`);
      expect(r1.code).not.toContain("Prerender(() =>");

      // Step 2: resolveId adds \0 prefix
      const resolved = plugin.resolveId.call({}, specifier, FILE_ID);
      expect(resolved).toBe("\0" + specifier);

      // Step 3: load synthesises the virtual module
      const loaded = plugin.load.call({}, resolved);
      expect(loaded).toBeDefined();
      expect(loaded).toContain(`export const ${exportName}`);
      expect(loaded).toContain("Prerender");
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
      const r1 = plugin.transform.call(
        rscCtx(),
        PRERENDER_INLINE_SOURCE,
        FILE_ID,
      );
      const { exportName, specifier } = extractVirtualImports(r1.code)[0];

      const resolved = plugin.resolveId.call({}, specifier, FILE_ID);
      const loaded = plugin.load.call({}, resolved);

      // Transform virtual module in client env -> stub
      const r2 = plugin.transform.call(clientCtx(), loaded, resolved);
      expect(r2).toBeDefined();
      expect(r2.code).toContain("__brand");
      expect(r2.code).toContain('"prerenderHandler"');
      expect(r2.code).toContain("$$id");
      // No Prerender call remains
      expect(r2.code).not.toContain("Prerender(");
    });
  });

  describe("mixed files (export const + inline)", () => {
    it("extracts inline, leaves export const, both get $$id in RSC", () => {
      const plugin = createPlugin();
      initDev(plugin);

      // Transform mixed source in RSC
      const r1 = plugin.transform.call(
        rscCtx(),
        PRERENDER_MIXED_SOURCE,
        FILE_ID,
      );
      expect(r1).toBeDefined();

      // Inline call extracted to virtual module
      const vImports = extractVirtualImports(r1.code);
      expect(vImports).toHaveLength(1);

      // Export const stays in the original file with $$id injected
      expect(r1.code).toContain("export const AboutPage = Prerender");
      expect(r1.code).toContain("AboutPage.$$id");

      // Inline call replaced with import name
      expect(r1.code).toContain(`path("/inline", ${vImports[0].exportName})`);
      expect(r1.code).not.toContain("Prerender(() => <aside />)");
    });
  });

  describe("module tracking (RSC build mode)", () => {
    it("populates prerenderHandlerModules for export const patterns", () => {
      const plugin = createPlugin({ forceBuild: true });
      initDev(plugin);

      plugin.transform.call(rscCtx(), PRERENDER_EXPORT_SOURCE, FILE_ID);

      expect(plugin.api.prerenderHandlerModules.get(FILE_ID)).toEqual([
        "AboutPage",
      ]);
    });
  });
});

describe("exposeInternalIds - unsupported shape diagnostics", () => {
  it("warns for createLoader when declaration uses let", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const code = `import { createLoader } from "@rangojs/router";
export let LocalLoader = createLoader(async () => ({ ok: true }));
`;
    const ctx = rscCtx();
    plugin.transform.call(ctx, code, FILE_ID);

    expect(ctx.warn).toHaveBeenCalledTimes(1);
    const [msg] = ctx.warn.mock.calls[0];
    expect(msg).toContain("Unsupported createLoader shape");
    expect(msg).toContain("Supported shapes are:");
  });

  it("does not warn for supported createLoader export const shape", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const code = `import { createLoader } from "@rangojs/router";
export const MyLoader = createLoader(async () => ({ ok: true }));
`;
    const ctx = rscCtx();
    plugin.transform.call(ctx, code, FILE_ID);

    expect(ctx.warn).not.toHaveBeenCalled();
  });

  it("warns at most once per file/function shape", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const code = `import { createHandle } from "@rangojs/router";
layout(createHandle(() => []));
`;
    const ctx = rscCtx();
    plugin.transform.call(ctx, code, FILE_ID);
    plugin.transform.call(ctx, code, FILE_ID);

    expect(ctx.warn).toHaveBeenCalledTimes(1);
    const [msg] = ctx.warn.mock.calls[0];
    expect(msg).toContain("Unsupported createHandle shape");
  });
});

describe("exposeInternalIds - alias support (strict create APIs)", () => {
  it("injects $$id for createLoader imported with alias", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const code = `import { createLoader as cl } from "@rangojs/router";
export const MyLoader = cl(async () => ({ ok: true }));
`;
    const result = plugin.transform.call(rscCtx(), code, FILE_ID);
    expect(result).toBeDefined();
    expect(result.code).toContain("MyLoader.$$id");
  });

  it("injects $$id for createHandle imported with alias", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const code = `import { createHandle as ch } from "@rangojs/router";
export const Breadcrumbs = ch(() => []);
`;
    const result = plugin.transform.call(rscCtx(), code, FILE_ID);
    expect(result).toBeDefined();
    expect(result.code).toContain("Breadcrumbs.$$id");
  });

  it("injects __rsc_ls_key for createLocationState imported with alias", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const code = `import { createLocationState as cls } from "@rangojs/router";
export const ProductState = cls<string>();
`;
    const result = plugin.transform.call(rscCtx(), code, FILE_ID);
    expect(result).toBeDefined();
    expect(result.code).toContain("ProductState.__rsc_ls_key");
  });

  it("supports createLoader declared as const and exported via specifier alias", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const code = `import { createLoader } from "@rangojs/router";
const LocalLoader = createLoader(async () => ({ ok: true }));
export { LocalLoader as PublicLoader };
`;
    const ctx = rscCtx();
    const result = plugin.transform.call(ctx, code, FILE_ID);
    expect(result).toBeDefined();
    expect(result.code).toContain("LocalLoader.$$id =");
    expect(ctx.warn).not.toHaveBeenCalled();
  });

  it("supports createHandle declared as const and exported via specifier", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const code = `import { createHandle } from "@rangojs/router";
const LocalHandle = createHandle(() => []);
export { LocalHandle };
`;
    const result = plugin.transform.call(rscCtx(), code, FILE_ID);
    expect(result).toBeDefined();
    expect(result.code).toContain("LocalHandle.$$id");
  });

  it("supports createLocationState declared as const and exported via specifier alias", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const code = `import { createLocationState } from "@rangojs/router";
const ProductStateDef = createLocationState<string>();
export { ProductStateDef as ProductState };
`;
    const result = plugin.transform.call(rscCtx(), code, FILE_ID);
    expect(result).toBeDefined();
    expect(result.code).toContain("ProductStateDef.__rsc_ls_key");
  });

  it("injects __rsc_ls_key for createLocationState with options arg", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const code = `import { createLocationState } from "@rangojs/router";
export const FlashMsg = createLocationState<{ text: string }>({ flash: true });
`;
    const result = plugin.transform.call(rscCtx(), code, FILE_ID);
    expect(result).toBeDefined();
    expect(result.code).toContain("FlashMsg.__rsc_ls_key");
  });
});

describe("exposeInternalIds - handler export specifiers", () => {
  it("tracks static handler exported via specifier alias in build mode", () => {
    const plugin = createPlugin({ forceBuild: true });
    initDev(plugin);

    const code = `import { Static } from "@rangojs/router";
const DocsNav = Static(() => <nav />);
export { DocsNav as DocsNavPublic };
`;
    plugin.transform.call(rscCtx(), code, FILE_ID);
    expect(plugin.api.staticHandlerModules.get(FILE_ID)).toEqual([
      "DocsNavPublic",
    ]);
  });

  it("tracks prerender handler exported via specifier alias in build mode", () => {
    const plugin = createPlugin({ forceBuild: true });
    initDev(plugin);

    const code = `import { Prerender } from "@rangojs/router";
const DocsPage = Prerender(() => <div />);
export { DocsPage as DocsPagePublic };
`;
    plugin.transform.call(rscCtx(), code, FILE_ID);
    expect(plugin.api.prerenderHandlerModules.get(FILE_ID)).toEqual([
      "DocsPagePublic",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Client loader stubs for const + export { X } pattern
// ---------------------------------------------------------------------------

describe("exposeInternalIds - client loader stubs for const + export patterns", () => {
  it("generates client stub for const + export { X }", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const code = `import { createLoader } from "@rangojs/router";
const MyLoader = createLoader(async () => ({ ok: true }));
export { MyLoader };
`;
    const result = plugin.transform.call(clientCtx(), code, FILE_ID);
    expect(result).toBeDefined();
    expect(result.code).toContain('__brand: "loader"');
    expect(result.code).toContain("$$id");
    expect(result.code).toContain("export const MyLoader");
    // Entire file replaced - no server code
    expect(result.code).not.toContain("async");
  });

  it("generates client stub for const + export { X as Y }", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const code = `import { createLoader } from "@rangojs/router";
const InternalLoader = createLoader(async () => ({ ok: true }));
export { InternalLoader as PublicLoader };
`;
    const result = plugin.transform.call(clientCtx(), code, FILE_ID);
    expect(result).toBeDefined();
    expect(result.code).toContain('__brand: "loader"');
    expect(result.code).toContain("export const PublicLoader");
    // Uses the exported name, not the local name
    expect(result.code).not.toContain("InternalLoader");
    expect(result.code).not.toContain("async");
  });

  it("does not generate loader-only stub when file has mixed exports (const + export pattern)", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const code = `import { createLoader } from "@rangojs/router";
const MyLoader = createLoader(async () => ({ ok: true }));
export { MyLoader };
export const helperFn = () => "not a loader";
`;
    const result = plugin.transform.call(clientCtx(), code, FILE_ID);
    // Should NOT replace entire file since helperFn is not a loader
    if (result) {
      expect(result.code).toContain("helperFn");
    }
  });
});

// ---------------------------------------------------------------------------
// Fetchable loader client stubs (action property)
// ---------------------------------------------------------------------------

describe("exposeInternalIds - fetchable loader client stubs", () => {
  it("generates client stub for fetchable loader (export-only file)", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const code = `import { createLoader } from "@rangojs/router";
export const MyLoader = createLoader(async () => ({ ok: true }), true);
`;
    const result = plugin.transform.call(clientCtx(), code, FILE_ID);
    expect(result).toBeDefined();
    expect(result.code).toContain('__brand: "loader"');
    expect(result.code).toContain("$$id");
    // No action wrapper — loaders are simple { __brand, $$id } stubs
    expect(result.code).not.toContain("action:");
    expect(result.code).not.toContain("__ifa");
    expect(result.code).not.toContain("invokeFetchableLoaderAction");
    // No server code
    expect(result.code).not.toContain("async () =>");
  });

  it("generates client stub without action for non-fetchable loader", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const code = `import { createLoader } from "@rangojs/router";
export const MyLoader = createLoader(async () => ({ ok: true }));
`;
    const result = plugin.transform.call(clientCtx(), code, FILE_ID);
    expect(result).toBeDefined();
    expect(result.code).toContain('__brand: "loader"');
    expect(result.code).not.toContain("action:");
    expect(result.code).not.toContain("__ifa");
    expect(result.code).not.toContain("invokeFetchableLoaderAction");
  });

  it("generates stubs for file with both fetchable and non-fetchable loaders", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const code = `import { createLoader } from "@rangojs/router";
export const ReadOnly = createLoader(async () => ({ data: "read" }));
export const Fetchable = createLoader(async () => ({ data: "write" }), true);
`;
    const result = plugin.transform.call(clientCtx(), code, FILE_ID);
    expect(result).toBeDefined();
    // No action wrappers on any stubs
    expect(result.code).not.toContain("invokeFetchableLoaderAction");
    expect(result.code).not.toContain("action:");
    // Both stubs have __brand and $$id
    expect(result.code).toMatch(/ReadOnly\s*=\s*\{[^}]*__brand/);
    expect(result.code).toMatch(/Fetchable\s*=\s*\{[^}]*__brand/);
  });

  it("client stub includes correct loader ID in dev mode", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const code = `import { createLoader } from "@rangojs/router";
export const CartLoader = createLoader(async () => ({ items: [] }), true);
`;
    const result = plugin.transform.call(clientCtx(), code, FILE_ID);
    expect(result).toBeDefined();
    // Stub should reference the correct loader ID
    expect(result.code).toContain("src/urls.tsx#CartLoader");
    // The ID appears once in $$id
    const idOccurrences = result.code.match(/src\/urls\.tsx#CartLoader/g);
    expect(idOccurrences).toHaveLength(1);
  });

  it("client stub includes correct loader ID in build mode", () => {
    const plugin = createPlugin({ forceBuild: true });
    initDev(plugin);

    const code = `import { createLoader } from "@rangojs/router";
export const CartLoader = createLoader(async () => ({ items: [] }), true);
`;
    const result = plugin.transform.call(clientCtx(), code, FILE_ID);
    expect(result).toBeDefined();
    // Build mode uses hashed IDs, appears once in $$id
    const ids = result.code.match(/[0-9a-f]{8}#CartLoader/g);
    expect(ids).toHaveLength(1);
  });

  it("does not inject action for fetchable loader in mixed file (transformLoaders path)", () => {
    const plugin = createPlugin();
    initDev(plugin);

    // Mixed file: has a non-loader export, so whole-file stub won't apply
    const code = `import { createLoader } from "@rangojs/router";
export const MyLoader = createLoader(async () => ({ ok: true }), true);
export const PAGE_TITLE = "docs";
`;
    const result = plugin.transform.call(clientCtx(), code, FILE_ID);
    expect(result).toBeDefined();
    // The non-loader export is preserved (not whole-file replaced)
    expect(result.code).toContain("PAGE_TITLE");
    // No action injection in transformLoaders path (only whole-file stubs get it)
    expect(result.code).not.toContain("MyLoader.action");
    expect(result.code).not.toContain("invokeFetchableLoaderAction");
    // $$id is still injected
    expect(result.code).toContain("MyLoader.$$id");
  });

  it("does not inject action for non-fetchable loader in mixed file", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const code = `import { createLoader } from "@rangojs/router";
export const MyLoader = createLoader(async () => ({ ok: true }));
export const PAGE_TITLE = "docs";
`;
    const result = plugin.transform.call(clientCtx(), code, FILE_ID);
    expect(result).toBeDefined();
    expect(result.code).toContain("PAGE_TITLE");
    expect(result.code).not.toContain(".action");
    expect(result.code).not.toContain("invokeFetchableLoaderAction");
  });

  it("does not inject action on server (RSC env)", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const code = `import { createLoader } from "@rangojs/router";
export const MyLoader = createLoader(async () => ({ ok: true }), true);
export const PAGE_TITLE = "docs";
`;
    const result = plugin.transform.call(rscCtx(), code, FILE_ID);
    expect(result).toBeDefined();
    // Server side should NOT have the fetchable action import
    expect(result.code).not.toContain("invokeFetchableLoaderAction");
    expect(result.code).not.toContain("__ifa");
  });

  it("generates client stub for fetchable loader using options object", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const code = `import { createLoader } from "@rangojs/router";
export const Guarded = createLoader(async () => ({ ok: true }), { middleware: [authMiddleware] });
`;
    const result = plugin.transform.call(clientCtx(), code, FILE_ID);
    expect(result).toBeDefined();
    // Client stub has __brand and $$id, no action wrapper
    expect(result.code).toContain('__brand: "loader"');
    expect(result.code).toContain("$$id");
    expect(result.code).not.toContain("action:");
    expect(result.code).not.toContain("__ifa");
  });
});

// ---------------------------------------------------------------------------
// Whole-file handler stubs for const + export { X } pattern
// ---------------------------------------------------------------------------

describe("exposeInternalIds - whole-file handler stubs for const + export patterns", () => {
  it("generates whole-file stub for static handler with const + export { X }", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const code = `import { Static } from "@rangojs/router";
const Nav = Static(() => <nav />);
export { Nav };
`;
    const result = plugin.transform.call(clientCtx(), code, FILE_ID);
    expect(result).toBeDefined();
    expect(result.code).toContain('__brand: "staticHandler"');
    expect(result.code).toContain("$$id");
    expect(result.code).toContain("export const Nav");
    expect(result.code).not.toContain("Static");
  });

  it("generates whole-file stub for prerender handler with const + export { X as Y }", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const code = `import { Prerender } from "@rangojs/router";
const InternalPage = Prerender(() => <div />);
export { InternalPage as PublicPage };
`;
    const result = plugin.transform.call(clientCtx(), code, FILE_ID);
    expect(result).toBeDefined();
    expect(result.code).toContain('__brand: "prerenderHandler"');
    expect(result.code).toContain("export const PublicPage");
    expect(result.code).not.toContain("InternalPage");
    expect(result.code).not.toContain("Prerender");
  });
});

// ---------------------------------------------------------------------------
// Expression stubs for const + export { X } pattern
// ---------------------------------------------------------------------------

describe("exposeInternalIds - expr stubs for const + export patterns", () => {
  it("overwrites call expression for static handler with const + export { X }", () => {
    const plugin = createPlugin();
    initDev(plugin);

    // Mixed file: has a non-handler export, so whole-file stub won't apply
    const code = `import { Static } from "@rangojs/router";
const Nav = Static(() => <nav />);
export { Nav };
export const PAGE_TITLE = "docs";
`;
    const result = plugin.transform.call(clientCtx(), code, FILE_ID);
    expect(result).toBeDefined();
    expect(result.code).toContain('__brand: "staticHandler"');
    expect(result.code).toContain("$$id");
    // The non-handler export is preserved
    expect(result.code).toContain("PAGE_TITLE");
    // The call expression is replaced with a stub object
    expect(result.code).not.toContain("Static(");
  });

  it("overwrites call expression for handler with const + export { X as Y }", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const code = `import { Static } from "@rangojs/router";
const Nav = Static(() => <nav />);
export { Nav as PublicNav };
export const PAGE_TITLE = "docs";
`;
    const result = plugin.transform.call(clientCtx(), code, FILE_ID);
    expect(result).toBeDefined();
    expect(result.code).toContain('__brand: "staticHandler"');
    expect(result.code).toContain("$$id");
    expect(result.code).toContain("PAGE_TITLE");
    expect(result.code).not.toContain("Static(");
  });
});

// ---------------------------------------------------------------------------
// Build-mode hashed ID test
// ---------------------------------------------------------------------------

describe("exposeInternalIds - build mode hashed IDs", () => {
  it("produces hashed IDs (not file paths) for createLoader in build mode", () => {
    const plugin = createPlugin({ forceBuild: true });
    initDev(plugin);

    const code = `import { createLoader } from "@rangojs/router";
export const cartLoader = createLoader(() => fetch("/api/cart"));
`;
    const result = plugin.transform.call(rscCtx(), code, FILE_ID);
    expect(result).toBeDefined();

    // Build mode: $$id should be a hash format "HASH#exportName", not "filePath#exportName"
    const idMatch = result.code.match(/cartLoader\.\$\$id\s*=\s*"([^"]+)"/);
    expect(idMatch).toBeDefined();
    const id = idMatch![1];
    // Should be hash#exportName format (8-char hex hash, not a file path)
    expect(id).toMatch(/^[0-9a-f]{8}#cartLoader$/);
    // Should NOT contain file path segments
    expect(id).not.toContain("/");
    expect(id).not.toContain("src");
  });

  it("produces file-path IDs (not hashes) for createLoader in dev mode", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const code = `import { createLoader } from "@rangojs/router";
export const cartLoader = createLoader(() => fetch("/api/cart"));
`;
    const result = plugin.transform.call(rscCtx(), code, FILE_ID);
    expect(result).toBeDefined();

    // Dev mode: $$id should be "filePath#exportName"
    const idMatch = result.code.match(/cartLoader\.\$\$id\s*=\s*"([^"]+)"/);
    expect(idMatch).toBeDefined();
    const id = idMatch![1];
    // Should contain file path, not a hash
    expect(id).toMatch(/src\/urls\.tsx#cartLoader$/);
  });

  it("produces hashed IDs for createHandle in build mode", () => {
    const plugin = createPlugin({ forceBuild: true });
    initDev(plugin);

    const code = `import { createHandle } from "@rangojs/router";
export const seoHandle = createHandle({ title: "Shop" });
`;
    const result = plugin.transform.call(rscCtx(), code, FILE_ID);
    expect(result).toBeDefined();

    const idMatch = result.code.match(/seoHandle\.\$\$id\s*=\s*"([^"]+)"/);
    expect(idMatch).toBeDefined();
    expect(idMatch![1]).toMatch(/^[0-9a-f]{8}#seoHandle$/);
  });

  it("produces hashed IDs for Static handler in build mode", () => {
    const plugin = createPlugin({ forceBuild: true });
    initDev(plugin);

    const code = `import { Static } from "@rangojs/router";
export const Nav = Static(() => <nav />);
`;
    const result = plugin.transform.call(rscCtx(), code, FILE_ID);
    expect(result).toBeDefined();

    const idMatch = result.code.match(/Nav\.\$\$id\s*=\s*"([^"]+)"/);
    expect(idMatch).toBeDefined();
    expect(idMatch![1]).toMatch(/^[0-9a-f]{8}#Nav$/);
  });

  it("uses same hash for dev and build client stubs", () => {
    // Dev mode
    const devPlugin = createPlugin();
    initDev(devPlugin);
    const code = `import { createLoader } from "@rangojs/router";
export const cartLoader = createLoader(() => fetch("/api/cart"));
`;
    const devResult = devPlugin.transform.call(clientCtx(), code, FILE_ID);
    expect(devResult).toBeDefined();
    const devId = devResult.code.match(/\$\$id:\s*"([^"]+)"/)?.[1];

    // Build mode
    const buildPlugin = createPlugin({ forceBuild: true });
    initDev(buildPlugin);
    const buildResult = buildPlugin.transform.call(clientCtx(), code, FILE_ID);
    expect(buildResult).toBeDefined();
    const buildId = buildResult.code.match(/\$\$id:\s*"([^"]+)"/)?.[1];

    // Client stubs should have the same ID format in both modes
    // (both reference the same loader by hash or path)
    expect(devId).toBeDefined();
    expect(buildId).toBeDefined();
    // Dev uses filePath#name, build uses hash#name — different formats
    expect(devId).toMatch(/src\/urls\.tsx#cartLoader/);
    expect(buildId).toMatch(/^[0-9a-f]{8}#cartLoader$/);
  });
});

// ---------------------------------------------------------------------------
// Mixed handler files: colocated createLoader/createHandle + Prerender/Static
// ---------------------------------------------------------------------------

describe("exposeInternalIds - mixed handler files (non-RSC)", () => {
  // Source with createLoader + createHandle + Prerender in the same file
  const MIXED_LOADER_PRERENDER = `import { createLoader, createHandle, Prerender } from "@rangojs/router";
export const MyLoader = createLoader(async () => ({ ok: true }));
export const MyHandle = createHandle();
export const MyPage = Prerender(() => <div>page</div>);
`;

  // Source with createLoader + Static in the same file
  const MIXED_LOADER_STATIC = `import { createLoader, Static } from "@rangojs/router";
export const MyLoader = createLoader(async () => ({ ok: true }));
export const Nav = Static(() => <nav />);
`;

  // Mixed file with server-only imports (simulates commerce SDK with node:fs)
  const MIXED_WITH_SERVER_IMPORTS = `import { createLoader, createHandle, Prerender } from "@rangojs/router";
import { readFileSync } from "node:fs";
export const MyLoader = createLoader(async () => ({ data: readFileSync("x") }));
export const MyHandle = createHandle();
export const MyPage = Prerender(() => <div>page</div>);
`;

  // Mixed file with non-recognized export (helper function)
  const MIXED_WITH_HELPER = `import { createLoader, Prerender } from "@rangojs/router";
export const MyLoader = createLoader(async () => ({ ok: true }));
export const MyPage = Prerender(() => <div>page</div>);
export const PAGE_TITLE = "docs";
`;

  it("replaces entire file with stubs in client env (loader + handle + Prerender)", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const result = plugin.transform.call(
      clientCtx(),
      MIXED_LOADER_PRERENDER,
      FILE_ID,
    );
    expect(result).toBeDefined();
    // All exports are stubs with $$id
    expect(result.code).toContain('__brand: "loader"');
    expect(result.code).toContain('__brand: "handle"');
    expect(result.code).toContain('__brand: "prerenderHandler"');
    // No original code remains
    expect(result.code).not.toContain("createLoader(");
    expect(result.code).not.toContain("createHandle(");
    expect(result.code).not.toContain("Prerender(");
    expect(result.code).not.toContain("import");
  });

  it("replaces entire file with stubs in client env (loader + Static)", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const result = plugin.transform.call(
      clientCtx(),
      MIXED_LOADER_STATIC,
      FILE_ID,
    );
    expect(result).toBeDefined();
    expect(result.code).toContain('__brand: "loader"');
    expect(result.code).toContain('__brand: "staticHandler"');
    expect(result.code).not.toContain("createLoader(");
    expect(result.code).not.toContain("Static(");
    expect(result.code).not.toContain("import");
  });

  it("strips server-only imports (node:fs) from mixed file stubs", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const result = plugin.transform.call(
      clientCtx(),
      MIXED_WITH_SERVER_IMPORTS,
      FILE_ID,
    );
    expect(result).toBeDefined();
    // Server-only imports must not appear in the stub output
    expect(result.code).not.toContain("node:fs");
    expect(result.code).not.toContain("readFileSync");
    // Stubs are present
    expect(result.code).toContain('__brand: "loader"');
    expect(result.code).toContain('__brand: "prerenderHandler"');
  });

  it("falls through to unified pipeline when file has non-recognized exports", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const result = plugin.transform.call(
      clientCtx(),
      MIXED_WITH_HELPER,
      FILE_ID,
    );
    expect(result).toBeDefined();
    // Non-recognized export preserved (not a whole-file stub)
    expect(result.code).toContain("PAGE_TITLE");
    // Prerender still gets stubbed via unified pipeline
    expect(result.code).toContain('"prerenderHandler"');
    // Loader still gets $$id via unified pipeline
    expect(result.code).toContain("MyLoader.$$id");
  });

  it("each stub has correct $$id in dev mode", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const result = plugin.transform.call(
      clientCtx(),
      MIXED_LOADER_PRERENDER,
      FILE_ID,
    );
    expect(result).toBeDefined();
    expect(result.code).toContain("src/urls.tsx#MyLoader");
    expect(result.code).toContain("src/urls.tsx#MyHandle");
    expect(result.code).toContain("src/urls.tsx#MyPage");
  });

  it("each stub has hashed $$id in build mode", () => {
    const plugin = createPlugin({ forceBuild: true });
    initDev(plugin);

    const result = plugin.transform.call(
      clientCtx(),
      MIXED_LOADER_PRERENDER,
      FILE_ID,
    );
    expect(result).toBeDefined();
    // Build mode uses hashed IDs
    expect(result.code).toMatch(/[0-9a-f]{8}#MyLoader/);
    expect(result.code).toMatch(/[0-9a-f]{8}#MyHandle/);
    expect(result.code).toMatch(/[0-9a-f]{8}#MyPage/);
  });

  it("all transforms work together in RSC env for mixed file", () => {
    const plugin = createPlugin();
    initDev(plugin);

    const result = plugin.transform.call(
      rscCtx(),
      MIXED_LOADER_PRERENDER,
      FILE_ID,
    );
    expect(result).toBeDefined();
    // RSC: loader gets $$id
    expect(result.code).toContain("MyLoader.$$id");
    // RSC: handle gets $$id
    expect(result.code).toContain("MyHandle.$$id");
    // RSC: Prerender gets $$id (not stubbed)
    expect(result.code).toContain("MyPage.$$id");
    expect(result.code).toContain("Prerender(");
  });
});
