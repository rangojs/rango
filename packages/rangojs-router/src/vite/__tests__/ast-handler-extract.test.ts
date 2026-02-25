import { describe, it, expect } from "vitest";
import { parseAst } from "vite";
import MagicString from "magic-string";
import {
  findHandlerCalls,
  extractImportDeclarations,
  extractModuleLevelDeclarations,
  transformInlineHandlers,
  type VirtualHandlerEntry,
} from "../ast-handler-extract.ts";
import { hashInlineId } from "../expose-id-utils.ts";

// ---------------------------------------------------------------------------
// findHandlerCalls (parameterized)
// ---------------------------------------------------------------------------

describe("findHandlerCalls", () => {
  it("detects export const pattern for Static", () => {
    const code = `
import { Static } from "@rangojs/router";
export const Nav = Static(() => <nav />);
`;
    const sites = findHandlerCalls(code, "Static", parseAst);
    expect(sites).toHaveLength(1);
    expect(sites[0].exportInfo).not.toBeNull();
    expect(sites[0].exportInfo!.exportName).toBe("Nav");
    expect(sites[0].argCount).toBe(1);
  });

  it("detects export const pattern for Prerender", () => {
    const code = `
import { Prerender } from "@rangojs/router";
export const Page = Prerender(() => <div />);
`;
    const sites = findHandlerCalls(code, "Prerender", parseAst);
    expect(sites).toHaveLength(1);
    expect(sites[0].exportInfo).not.toBeNull();
    expect(sites[0].exportInfo!.exportName).toBe("Page");
    expect(sites[0].argCount).toBe(1);
  });

  it("detects inline call for Prerender", () => {
    const code = `
import { Prerender } from "@rangojs/router";
path("/about", Prerender(() => <div>About</div>));
`;
    const sites = findHandlerCalls(code, "Prerender", parseAst);
    expect(sites).toHaveLength(1);
    expect(sites[0].exportInfo).toBeNull();
    expect(sites[0].argCount).toBe(1);
  });

  it("detects mixed file for Prerender", () => {
    const code = `
import { Prerender } from "@rangojs/router";
export const Page = Prerender(() => <main />);
path("/inline", Prerender(() => <aside />));
`;
    const sites = findHandlerCalls(code, "Prerender", parseAst);
    expect(sites).toHaveLength(2);

    const exported = sites.find((s) => s.exportInfo !== null);
    const inline = sites.find((s) => s.exportInfo === null);

    expect(exported).toBeDefined();
    expect(exported!.exportInfo!.exportName).toBe("Page");
    expect(inline).toBeDefined();
  });

  it("ignores calls with non-matching fnName", () => {
    const code = `
import { Static } from "@rangojs/router";
export const Nav = Static(() => <nav />);
`;
    const sites = findHandlerCalls(code, "Prerender", parseAst);
    expect(sites).toEqual([]);
  });

  it("detects aliased import calls for Static", () => {
    const code = `
import { Static as sh } from "@rangojs/router";
layout(sh(() => <nav />));
`;
    const sites = findHandlerCalls(code, "Static", parseAst);
    expect(sites).toHaveLength(1);
    expect(sites[0].calleeName).toBe("sh");
    expect(sites[0].exportInfo).toBeNull();
  });

  it("detects aliased export const calls for Prerender", () => {
    const code = `
import { Prerender as ph } from "@rangojs/router";
export const About = ph(() => <div />);
`;
    const sites = findHandlerCalls(code, "Prerender", parseAst);
    expect(sites).toHaveLength(1);
    expect(sites[0].calleeName).toBe("ph");
    expect(sites[0].exportInfo?.exportName).toBe("About");
  });

  it("detects const + export specifier for Static", () => {
    const code = `
import { Static } from "@rangojs/router";
const NavDef = Static(() => <nav />);
export { NavDef as Nav };
`;
    const sites = findHandlerCalls(code, "Static", parseAst);
    expect(sites).toHaveLength(1);
    expect(sites[0].exportInfo).not.toBeNull();
    expect(sites[0].exportInfo?.exportName).toBe("Nav");
  });
});

// ---------------------------------------------------------------------------
// extractImportDeclarations
// ---------------------------------------------------------------------------

describe("extractImportDeclarations", () => {
  it("extracts all import declarations", () => {
    // Post-esbuild: `import type` is stripped, only runtime imports remain
    const code = `import { Static } from "@rangojs/router";
import { Nav } from "./components/Nav";
import { readFile } from "node:fs";

export const X = Static(() => Nav());
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
// extractModuleLevelDeclarations
// ---------------------------------------------------------------------------

describe("extractModuleLevelDeclarations", () => {
  it("extracts safe declarations (literals, functions, arrows)", () => {
    const code = `import { Static } from "@rangojs/router";
let counter = 0;
var flag = true;
const ITEMS = [1, 2, 3];
const CONFIG = { key: "value", count: 42 };
const fn = () => counter + 1;
function helper() { return 42; }

layout(Static(() => <div />));
`;
    const decls = extractModuleLevelDeclarations(
      code,
      parseAst,
      new Set(["Static"]),
    );
    expect(decls).toHaveLength(6);
    expect(decls[0]).toContain("let counter");
    expect(decls[1]).toContain("var flag");
    expect(decls[2]).toContain("const ITEMS");
    expect(decls[3]).toContain("const CONFIG");
    expect(decls[4]).toContain("const fn");
    expect(decls[5]).toContain("function helper");
  });

  it("skips declarations that reference identifiers (unsafe for separate chunks)", () => {
    const code = `import { Static } from "@rangojs/router";
import * as React from "react";
const VT = React.Fragment;
const result = someFunction();
const alias = existingVar;

layout(Static(() => <div />));
`;
    const decls = extractModuleLevelDeclarations(
      code,
      parseAst,
      new Set(["Static"]),
    );
    expect(decls).toHaveLength(0);
  });

  it("excludes declarations that are handler calls", () => {
    const code = `import { Static, Prerender } from "@rangojs/router";
const ITEMS = [1, 2];
const Nav = Static(() => <nav />);
const Page = Prerender(() => <div />);

layout(Static(() => <div />));
`;
    const decls = extractModuleLevelDeclarations(
      code,
      parseAst,
      new Set(["Static", "Prerender"]),
    );
    expect(decls).toHaveLength(1);
    expect(decls[0]).toContain("const ITEMS");
  });

  it("strips export keyword from exported declarations", () => {
    const code = `import { Static } from "@rangojs/router";
export const ITEMS = [1, 2, 3];
export function helper() { return 42; }

layout(Static(() => helper()));
`;
    const decls = extractModuleLevelDeclarations(
      code,
      parseAst,
      new Set(["Static"]),
    );
    expect(decls).toHaveLength(2);
    expect(decls[0]).not.toMatch(/^export/);
    expect(decls[0]).toContain("const ITEMS");
    expect(decls[1]).not.toMatch(/^export/);
    expect(decls[1]).toContain("function helper");
  });

  it("skips class declarations and re-exports", () => {
    const code = `import { Static } from "@rangojs/router";
class Formatter {}
export { something } from "./other";

layout(Static(() => <div />));
`;
    const decls = extractModuleLevelDeclarations(
      code,
      parseAst,
      new Set(["Static"]),
    );
    expect(decls).toHaveLength(0);
  });

  it("skips expression statements (side effects)", () => {
    const code = `import { Static } from "@rangojs/router";
console.log("loaded");
const ITEMS = [1, 2];

layout(Static(() => <div />));
`;
    const decls = extractModuleLevelDeclarations(
      code,
      parseAst,
      new Set(["Static"]),
    );
    expect(decls).toHaveLength(1);
    expect(decls[0]).toContain("const ITEMS");
  });

  it("returns empty array on parse failure", () => {
    const decls = extractModuleLevelDeclarations(
      "{{invalid",
      parseAst,
      new Set(),
    );
    expect(decls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// transformInlineHandlers (parameterized)
// ---------------------------------------------------------------------------

describe("transformInlineHandlers", () => {
  it("extracts inline Static call to virtual module", () => {
    const code = `import { Static } from "@rangojs/router";
layout(Static(() => <nav />));
`;
    const s = new MagicString(code);
    const registry = new Map<string, VirtualHandlerEntry>();

    const result = transformInlineHandlers(
      "Static",
      "virtual:handler-extract:",
      s,
      code,
      "src/urls.tsx",
      registry,
      "/abs/src/urls.tsx",
      parseAst,
    );

    expect(result).toBe(true);
    expect(registry.size).toBe(1);

    const entry = [...registry.values()][0];
    expect(entry.originalModuleId).toBe("/abs/src/urls.tsx");
    expect(entry.handlerCode).toContain("Static");
    expect(entry.exportName).toMatch(/^__sh_[0-9a-f]{8}$/);
    expect(entry.imports).toHaveLength(1);
    expect(entry.imports[0]).toContain("@rangojs/router");

    const output = s.toString();
    expect(output).toContain(`import { ${entry.exportName} }`);
    expect(output).toContain("virtual:handler-extract:");
    expect(output).toContain(`layout(${entry.exportName})`);
    expect(output).not.toContain("Static(() => <nav />)");
  });

  it("extracts inline Prerender call to virtual module", () => {
    const code = `import { Prerender } from "@rangojs/router";
path("/about", Prerender(() => <div>About</div>));
`;
    const s = new MagicString(code);
    const registry = new Map<string, VirtualHandlerEntry>();

    const result = transformInlineHandlers(
      "Prerender",
      "virtual:handler-extract:",
      s,
      code,
      "src/urls.tsx",
      registry,
      "/abs/src/urls.tsx",
      parseAst,
    );

    expect(result).toBe(true);
    expect(registry.size).toBe(1);

    const entry = [...registry.values()][0];
    expect(entry.originalModuleId).toBe("/abs/src/urls.tsx");
    expect(entry.handlerCode).toContain("Prerender");
    expect(entry.exportName).toMatch(/^__sh_[0-9a-f]{8}$/);

    const output = s.toString();
    expect(output).toContain(`import { ${entry.exportName} }`);
    expect(output).toContain("virtual:handler-extract:");
    expect(output).toContain(`path("/about", ${entry.exportName})`);
    expect(output).not.toContain("Prerender(() =>");
  });

  it("preserves directive prologue when inserting virtual imports", () => {
    const code = `"use client";
import { Static } from "@rangojs/router";
layout(Static(() => <nav />));
`;
    const s = new MagicString(code);
    const registry = new Map<string, VirtualHandlerEntry>();

    const result = transformInlineHandlers(
      "Static",
      "virtual:handler-extract:",
      s,
      code,
      "src/urls.tsx",
      registry,
      "/abs/src/urls.tsx",
      parseAst,
    );

    expect(result).toBe(true);
    const output = s.toString();

    const directivePos = output.indexOf(`"use client";`);
    const routerImportPos = output.indexOf(
      `import { Static } from "@rangojs/router";`,
    );
    const virtualImportPos = output.indexOf(`import { __sh_`);

    expect(directivePos).toBeGreaterThanOrEqual(0);
    expect(routerImportPos).toBeGreaterThan(directivePos);
    expect(virtualImportPos).toBeGreaterThan(routerImportPos);
  });

  it("does not extract export const calls", () => {
    const code = `import { Static } from "@rangojs/router";
export const Nav = Static(() => <nav />);
`;
    const s = new MagicString(code);
    const registry = new Map<string, VirtualHandlerEntry>();

    const result = transformInlineHandlers(
      "Static",
      "virtual:handler-extract:",
      s,
      code,
      "src/urls.tsx",
      registry,
      "/abs/src/urls.tsx",
      parseAst,
    );

    expect(result).toBe(false);
    expect(registry.size).toBe(0);
  });

  it("does not extract const + export specifier calls", () => {
    const code = `import { Static } from "@rangojs/router";
const NavDef = Static(() => <nav />);
export { NavDef as Nav };
`;
    const s = new MagicString(code);
    const registry = new Map<string, VirtualHandlerEntry>();

    const result = transformInlineHandlers(
      "Static",
      "virtual:handler-extract:",
      s,
      code,
      "src/urls.tsx",
      registry,
      "/abs/src/urls.tsx",
      parseAst,
    );

    expect(result).toBe(false);
    expect(registry.size).toBe(0);
  });

  it("handles multiple inline calls", () => {
    const code = `import { Static } from "@rangojs/router";
layout(Static(() => <nav />));
path("/about", Static(() => <about />));
`;
    const s = new MagicString(code);
    const registry = new Map<string, VirtualHandlerEntry>();

    const result = transformInlineHandlers(
      "Static",
      "virtual:handler-extract:",
      s,
      code,
      "src/urls.tsx",
      registry,
      "/abs/src/urls.tsx",
      parseAst,
    );

    expect(result).toBe(true);
    expect(registry.size).toBe(2);

    const output = s.toString();
    expect(output).not.toContain("Static(() => <nav />)");
    expect(output).not.toContain("Static(() => <about />)");
  });

  it("extracts only inline calls from mixed file", () => {
    const code = `import { Static } from "@rangojs/router";
export const Nav = Static(() => <nav />);
layout(Static(() => <sidebar />));
`;
    const s = new MagicString(code);
    const registry = new Map<string, VirtualHandlerEntry>();

    const result = transformInlineHandlers(
      "Static",
      "virtual:handler-extract:",
      s,
      code,
      "src/urls.tsx",
      registry,
      "/abs/src/urls.tsx",
      parseAst,
    );

    expect(result).toBe(true);
    expect(registry.size).toBe(1);

    const output = s.toString();
    // Export const should remain untouched
    expect(output).toContain("export const Nav = Static");
    // Inline should be replaced
    expect(output).not.toContain("Static(() => <sidebar />)");
  });

  it("copies all imports to virtual module entry", () => {
    const code = `import { Static } from "@rangojs/router";
import { Nav } from "./components/Nav";
import { readFile } from "node:fs";

layout(Static(() => <Nav />));
`;
    const s = new MagicString(code);
    const registry = new Map<string, VirtualHandlerEntry>();

    transformInlineHandlers(
      "Static",
      "virtual:handler-extract:",
      s,
      code,
      "src/urls.tsx",
      registry,
      "/abs/src/urls.tsx",
      parseAst,
    );

    const entry = [...registry.values()][0];
    expect(entry.imports).toHaveLength(3);
    expect(entry.imports[0]).toContain("@rangojs/router");
    expect(entry.imports[1]).toContain("./components/Nav");
    expect(entry.imports[2]).toContain("node:fs");
  });

  it("includes safe module-level declarations in virtual entry", () => {
    const code = `import { Static } from "@rangojs/router";
const ITEMS = [1, 2, 3];
const CONFIG = { key: "value" };
const helper = () => ITEMS.length;

layout(Static(() => helper()));
`;
    const s = new MagicString(code);
    const registry = new Map<string, VirtualHandlerEntry>();

    transformInlineHandlers(
      "Static",
      "virtual:handler-extract:",
      s,
      code,
      "src/urls.tsx",
      registry,
      "/abs/src/urls.tsx",
      parseAst,
    );

    const entry = [...registry.values()][0];
    expect(entry.declarations).toHaveLength(3);
    expect(entry.declarations[0]).toContain("const ITEMS");
    expect(entry.declarations[1]).toContain("const CONFIG");
    expect(entry.declarations[2]).toContain("const helper");
  });

  it("excludes unsafe declarations and handler calls from virtual entry", () => {
    const code = `import { Static } from "@rangojs/router";
import * as React from "react";
const VT = React.Fragment;
const ITEMS = [1, 2];
const Nav = Static(() => <nav />);

layout(Static(() => <div />));
`;
    const s = new MagicString(code);
    const registry = new Map<string, VirtualHandlerEntry>();

    transformInlineHandlers(
      "Static",
      "virtual:handler-extract:",
      s,
      code,
      "src/urls.tsx",
      registry,
      "/abs/src/urls.tsx",
      parseAst,
    );

    const entries = [...registry.values()];
    for (const entry of entries) {
      // Only ITEMS is safe (literal array); VT references React, Nav is handler call
      expect(entry.declarations).toHaveLength(1);
      expect(entry.declarations[0]).toContain("const ITEMS");
      expect(entry.declarations.some((d) => d.includes("VT"))).toBe(false);
      expect(entry.declarations.some((d) => d.includes("Nav"))).toBe(false);
    }
  });

  it("handles same-line collisions with index tiebreaker", () => {
    const code = `import { Static } from "@rangojs/router";
layout(Static(() => <a />), Static(() => <b />));
`;
    const s = new MagicString(code);
    const registry = new Map<string, VirtualHandlerEntry>();

    transformInlineHandlers(
      "Static",
      "virtual:handler-extract:",
      s,
      code,
      "src/urls.tsx",
      registry,
      "/abs/src/urls.tsx",
      parseAst,
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
