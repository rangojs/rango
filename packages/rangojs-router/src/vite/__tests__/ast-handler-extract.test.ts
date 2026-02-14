import { describe, it, expect } from "vitest";
import { parseAst } from "vite";
import MagicString from "magic-string";
import {
  findHandlerCalls,
  extractImportDeclarations,
  transformInlineHandlers,
  type VirtualHandlerEntry,
} from "../ast-handler-extract.ts";
import { hashInlineId } from "../expose-id-utils.ts";

// ---------------------------------------------------------------------------
// findHandlerCalls (parameterized)
// ---------------------------------------------------------------------------

describe("findHandlerCalls", () => {
  it("detects export const pattern for createStaticHandler", () => {
    const code = `
import { createStaticHandler } from "@rangojs/router";
export const Nav = createStaticHandler(() => <nav />);
`;
    const sites = findHandlerCalls(code, "createStaticHandler", parseAst);
    expect(sites).toHaveLength(1);
    expect(sites[0].exportInfo).not.toBeNull();
    expect(sites[0].exportInfo!.exportName).toBe("Nav");
    expect(sites[0].argCount).toBe(1);
  });

  it("detects export const pattern for createPrerenderHandler", () => {
    const code = `
import { createPrerenderHandler } from "@rangojs/router";
export const Page = createPrerenderHandler(() => <div />);
`;
    const sites = findHandlerCalls(code, "createPrerenderHandler", parseAst);
    expect(sites).toHaveLength(1);
    expect(sites[0].exportInfo).not.toBeNull();
    expect(sites[0].exportInfo!.exportName).toBe("Page");
    expect(sites[0].argCount).toBe(1);
  });

  it("detects inline call for createPrerenderHandler", () => {
    const code = `
import { createPrerenderHandler } from "@rangojs/router";
path("/about", createPrerenderHandler(() => <div>About</div>));
`;
    const sites = findHandlerCalls(code, "createPrerenderHandler", parseAst);
    expect(sites).toHaveLength(1);
    expect(sites[0].exportInfo).toBeNull();
    expect(sites[0].argCount).toBe(1);
  });

  it("detects mixed file for createPrerenderHandler", () => {
    const code = `
import { createPrerenderHandler } from "@rangojs/router";
export const Page = createPrerenderHandler(() => <main />);
path("/inline", createPrerenderHandler(() => <aside />));
`;
    const sites = findHandlerCalls(code, "createPrerenderHandler", parseAst);
    expect(sites).toHaveLength(2);

    const exported = sites.find((s) => s.exportInfo !== null);
    const inline = sites.find((s) => s.exportInfo === null);

    expect(exported).toBeDefined();
    expect(exported!.exportInfo!.exportName).toBe("Page");
    expect(inline).toBeDefined();
  });

  it("ignores calls with non-matching fnName", () => {
    const code = `
import { createStaticHandler } from "@rangojs/router";
export const Nav = createStaticHandler(() => <nav />);
`;
    const sites = findHandlerCalls(code, "createPrerenderHandler", parseAst);
    expect(sites).toEqual([]);
  });

  it("detects aliased import calls for createStaticHandler", () => {
    const code = `
import { createStaticHandler as sh } from "@rangojs/router";
layout(sh(() => <nav />));
`;
    const sites = findHandlerCalls(code, "createStaticHandler", parseAst);
    expect(sites).toHaveLength(1);
    expect(sites[0].calleeName).toBe("sh");
    expect(sites[0].exportInfo).toBeNull();
  });

  it("detects aliased export const calls for createPrerenderHandler", () => {
    const code = `
import { createPrerenderHandler as ph } from "@rangojs/router";
export const About = ph(() => <div />);
`;
    const sites = findHandlerCalls(code, "createPrerenderHandler", parseAst);
    expect(sites).toHaveLength(1);
    expect(sites[0].calleeName).toBe("ph");
    expect(sites[0].exportInfo?.exportName).toBe("About");
  });
});

// ---------------------------------------------------------------------------
// extractImportDeclarations
// ---------------------------------------------------------------------------

describe("extractImportDeclarations", () => {
  it("extracts all import declarations", () => {
    // Post-esbuild: `import type` is stripped, only runtime imports remain
    const code = `import { createStaticHandler } from "@rangojs/router";
import { Nav } from "./components/Nav";
import { readFile } from "node:fs";

export const X = createStaticHandler(() => Nav());
`;
    const imports = extractImportDeclarations(code, parseAst);
    expect(imports).toHaveLength(3);
    expect(imports[0]).toContain("@rangojs/router");
    expect(imports[1]).toContain("./components/Nav");
    expect(imports[2]).toContain("node:fs");
  });

  it("returns empty array on parse failure", () => {
    const imports = extractImportDeclarations("{{invalid", parseAst);
    expect(imports).toEqual([]);
  });

  it("returns empty array for files with no imports", () => {
    const code = `const x = 1;`;
    const imports = extractImportDeclarations(code, parseAst);
    expect(imports).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// transformInlineHandlers (parameterized)
// ---------------------------------------------------------------------------

describe("transformInlineHandlers", () => {
  it("extracts inline createStaticHandler call to virtual module", () => {
    const code = `import { createStaticHandler } from "@rangojs/router";
layout(createStaticHandler(() => <nav />));
`;
    const s = new MagicString(code);
    const registry = new Map<string, VirtualHandlerEntry>();

    const result = transformInlineHandlers(
      "createStaticHandler", "virtual:handler-extract:",
      s, code, "src/urls.tsx", registry, "/abs/src/urls.tsx", parseAst,
    );

    expect(result).toBe(true);
    expect(registry.size).toBe(1);

    const entry = [...registry.values()][0];
    expect(entry.originalModuleId).toBe("/abs/src/urls.tsx");
    expect(entry.handlerCode).toContain("createStaticHandler");
    expect(entry.exportName).toMatch(/^__sh_[0-9a-f]{8}$/);
    expect(entry.imports).toHaveLength(1);
    expect(entry.imports[0]).toContain("@rangojs/router");

    const output = s.toString();
    expect(output).toContain(`import { ${entry.exportName} }`);
    expect(output).toContain("virtual:handler-extract:");
    expect(output).toContain(`layout(${entry.exportName})`);
    expect(output).not.toContain("createStaticHandler(() => <nav />)");
  });

  it("extracts inline createPrerenderHandler call to virtual module", () => {
    const code = `import { createPrerenderHandler } from "@rangojs/router";
path("/about", createPrerenderHandler(() => <div>About</div>));
`;
    const s = new MagicString(code);
    const registry = new Map<string, VirtualHandlerEntry>();

    const result = transformInlineHandlers(
      "createPrerenderHandler", "virtual:handler-extract:",
      s, code, "src/urls.tsx", registry, "/abs/src/urls.tsx", parseAst,
    );

    expect(result).toBe(true);
    expect(registry.size).toBe(1);

    const entry = [...registry.values()][0];
    expect(entry.originalModuleId).toBe("/abs/src/urls.tsx");
    expect(entry.handlerCode).toContain("createPrerenderHandler");
    expect(entry.exportName).toMatch(/^__sh_[0-9a-f]{8}$/);

    const output = s.toString();
    expect(output).toContain(`import { ${entry.exportName} }`);
    expect(output).toContain("virtual:handler-extract:");
    expect(output).toContain(`path("/about", ${entry.exportName})`);
    expect(output).not.toContain("createPrerenderHandler(() =>");
  });

  it("preserves directive prologue when inserting virtual imports", () => {
    const code = `"use client";
import { createStaticHandler } from "@rangojs/router";
layout(createStaticHandler(() => <nav />));
`;
    const s = new MagicString(code);
    const registry = new Map<string, VirtualHandlerEntry>();

    const result = transformInlineHandlers(
      "createStaticHandler", "virtual:handler-extract:",
      s, code, "src/urls.tsx", registry, "/abs/src/urls.tsx", parseAst,
    );

    expect(result).toBe(true);
    const output = s.toString();

    const directivePos = output.indexOf(`"use client";`);
    const routerImportPos = output.indexOf(
      `import { createStaticHandler } from "@rangojs/router";`,
    );
    const virtualImportPos = output.indexOf(
      `import { __sh_`,
    );

    expect(directivePos).toBeGreaterThanOrEqual(0);
    expect(routerImportPos).toBeGreaterThan(directivePos);
    expect(virtualImportPos).toBeGreaterThan(routerImportPos);
  });

  it("does not extract export const calls", () => {
    const code = `import { createStaticHandler } from "@rangojs/router";
export const Nav = createStaticHandler(() => <nav />);
`;
    const s = new MagicString(code);
    const registry = new Map<string, VirtualHandlerEntry>();

    const result = transformInlineHandlers(
      "createStaticHandler", "virtual:handler-extract:",
      s, code, "src/urls.tsx", registry, "/abs/src/urls.tsx", parseAst,
    );

    expect(result).toBe(false);
    expect(registry.size).toBe(0);
  });

  it("handles multiple inline calls", () => {
    const code = `import { createStaticHandler } from "@rangojs/router";
layout(createStaticHandler(() => <nav />));
path("/about", createStaticHandler(() => <about />));
`;
    const s = new MagicString(code);
    const registry = new Map<string, VirtualHandlerEntry>();

    const result = transformInlineHandlers(
      "createStaticHandler", "virtual:handler-extract:",
      s, code, "src/urls.tsx", registry, "/abs/src/urls.tsx", parseAst,
    );

    expect(result).toBe(true);
    expect(registry.size).toBe(2);

    const output = s.toString();
    expect(output).not.toContain("createStaticHandler(() => <nav />)");
    expect(output).not.toContain("createStaticHandler(() => <about />)");
  });

  it("extracts only inline calls from mixed file", () => {
    const code = `import { createStaticHandler } from "@rangojs/router";
export const Nav = createStaticHandler(() => <nav />);
layout(createStaticHandler(() => <sidebar />));
`;
    const s = new MagicString(code);
    const registry = new Map<string, VirtualHandlerEntry>();

    const result = transformInlineHandlers(
      "createStaticHandler", "virtual:handler-extract:",
      s, code, "src/urls.tsx", registry, "/abs/src/urls.tsx", parseAst,
    );

    expect(result).toBe(true);
    expect(registry.size).toBe(1);

    const output = s.toString();
    // Export const should remain untouched
    expect(output).toContain("export const Nav = createStaticHandler");
    // Inline should be replaced
    expect(output).not.toContain("createStaticHandler(() => <sidebar />)");
  });

  it("copies all imports to virtual module entry", () => {
    const code = `import { createStaticHandler } from "@rangojs/router";
import { Nav } from "./components/Nav";
import { readFile } from "node:fs";

layout(createStaticHandler(() => <Nav />));
`;
    const s = new MagicString(code);
    const registry = new Map<string, VirtualHandlerEntry>();

    transformInlineHandlers(
      "createStaticHandler", "virtual:handler-extract:",
      s, code, "src/urls.tsx", registry, "/abs/src/urls.tsx", parseAst,
    );

    const entry = [...registry.values()][0];
    expect(entry.imports).toHaveLength(3);
    expect(entry.imports[0]).toContain("@rangojs/router");
    expect(entry.imports[1]).toContain("./components/Nav");
    expect(entry.imports[2]).toContain("node:fs");
  });

  it("handles same-line collisions with index tiebreaker", () => {
    const code = `import { createStaticHandler } from "@rangojs/router";
layout(createStaticHandler(() => <a />), createStaticHandler(() => <b />));
`;
    const s = new MagicString(code);
    const registry = new Map<string, VirtualHandlerEntry>();

    transformInlineHandlers(
      "createStaticHandler", "virtual:handler-extract:",
      s, code, "src/urls.tsx", registry, "/abs/src/urls.tsx", parseAst,
    );

    expect(registry.size).toBe(2);
    const exportNames = [...registry.values()].map((e) => e.exportName);
    // Different export names due to collision handling
    expect(exportNames[0]).not.toBe(exportNames[1]);
  });
});

// ---------------------------------------------------------------------------
// hashInlineId
// ---------------------------------------------------------------------------

describe("hashInlineId", () => {
  it("generates consistent hashes", () => {
    const a = hashInlineId("src/urls.tsx", 42);
    const b = hashInlineId("src/urls.tsx", 42);
    expect(a).toBe(b);
  });

  it("produces 8-char hex string", () => {
    const hash = hashInlineId("src/urls.tsx", 10);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("produces different hashes for different lines", () => {
    const a = hashInlineId("src/urls.tsx", 10);
    const b = hashInlineId("src/urls.tsx", 20);
    expect(a).not.toBe(b);
  });

  it("produces different hashes with index tiebreaker", () => {
    const a = hashInlineId("src/urls.tsx", 10, 0);
    const b = hashInlineId("src/urls.tsx", 10, 1);
    expect(a).not.toBe(b);
  });

  it("index=0 produces same hash as no index", () => {
    const a = hashInlineId("src/urls.tsx", 10);
    const b = hashInlineId("src/urls.tsx", 10, 0);
    expect(a).toBe(b);
  });
});
