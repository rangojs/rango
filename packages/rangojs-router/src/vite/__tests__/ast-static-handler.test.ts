import { describe, it, expect } from "vitest";
import { parseAst } from "vite";
import MagicString from "magic-string";
import {
  findStaticHandlerCalls,
  extractImportDeclarations,
  transformInlineStaticHandlers,
  type VirtualStaticHandlerEntry,
} from "../ast-static-handler.ts";
import { hashInlineId } from "../expose-id-utils.ts";

// ---------------------------------------------------------------------------
// findStaticHandlerCalls
// ---------------------------------------------------------------------------

describe("findStaticHandlerCalls", () => {
  it("detects export const pattern", () => {
    const code = `
import { createStaticHandler } from "@rangojs/router";
export const Nav = createStaticHandler(() => <nav />);
`;
    const sites = findStaticHandlerCalls(code, parseAst);
    expect(sites).toHaveLength(1);
    expect(sites[0].exportInfo).not.toBeNull();
    expect(sites[0].exportInfo!.exportName).toBe("Nav");
    expect(sites[0].argCount).toBe(1);
  });

  it("detects export const with generics (post-esbuild JS)", () => {
    // By the time our transform runs (enforce: "post"), esbuild has already
    // stripped TypeScript generics, so the code is plain JS.
    const code = `
import { createStaticHandler } from "@rangojs/router";
export const Nav = createStaticHandler(() => <nav />);
`;
    const sites = findStaticHandlerCalls(code, parseAst);
    expect(sites).toHaveLength(1);
    expect(sites[0].exportInfo).not.toBeNull();
    expect(sites[0].exportInfo!.exportName).toBe("Nav");
  });

  it("detects export const with options", () => {
    const code = `
import { createStaticHandler } from "@rangojs/router";
export const Nav = createStaticHandler(() => <nav />, { passthrough: true });
`;
    const sites = findStaticHandlerCalls(code, parseAst);
    expect(sites).toHaveLength(1);
    expect(sites[0].argCount).toBe(2);
    expect(sites[0].exportInfo!.exportName).toBe("Nav");
  });

  it("detects inline call", () => {
    const code = `
import { createStaticHandler } from "@rangojs/router";
layout(createStaticHandler(() => <nav />));
`;
    const sites = findStaticHandlerCalls(code, parseAst);
    expect(sites).toHaveLength(1);
    expect(sites[0].exportInfo).toBeNull();
    expect(sites[0].argCount).toBe(1);
  });

  it("detects mixed file (export + inline)", () => {
    const code = `
import { createStaticHandler } from "@rangojs/router";
export const Nav = createStaticHandler(() => <nav />);
layout(createStaticHandler(() => <sidebar />));
`;
    const sites = findStaticHandlerCalls(code, parseAst);
    expect(sites).toHaveLength(2);

    const exported = sites.find((s) => s.exportInfo !== null);
    const inline = sites.find((s) => s.exportInfo === null);

    expect(exported).toBeDefined();
    expect(exported!.exportInfo!.exportName).toBe("Nav");
    expect(inline).toBeDefined();
  });

  it("computes correct line numbers", () => {
    const code = `import { createStaticHandler } from "@rangojs/router";

export const Nav = createStaticHandler(() => <nav />);

layout(createStaticHandler(() => <sidebar />));
`;
    const sites = findStaticHandlerCalls(code, parseAst);
    const exported = sites.find((s) => s.exportInfo !== null)!;
    const inline = sites.find((s) => s.exportInfo === null)!;

    expect(exported.lineNumber).toBe(3);
    expect(inline.lineNumber).toBe(5);
  });

  it("handles JSX in handler body", () => {
    const code = `
import { createStaticHandler } from "@rangojs/router";
layout(createStaticHandler(() => <div className="test"><span>Hello</span></div>));
`;
    const sites = findStaticHandlerCalls(code, parseAst);
    expect(sites).toHaveLength(1);
    expect(sites[0].exportInfo).toBeNull();
  });

  it("returns empty array on parse failure", () => {
    const code = `this is not valid javascript {{{`;
    const sites = findStaticHandlerCalls(code, parseAst);
    expect(sites).toEqual([]);
  });

  it("ignores non-createStaticHandler calls", () => {
    const code = `
import { createLoader } from "@rangojs/router";
export const MyLoader = createLoader(() => {});
`;
    const sites = findStaticHandlerCalls(code, parseAst);
    expect(sites).toEqual([]);
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
// transformInlineStaticHandlers
// ---------------------------------------------------------------------------

describe("transformInlineStaticHandlers", () => {
  it("extracts inline call to virtual module", () => {
    const code = `import { createStaticHandler } from "@rangojs/router";
layout(createStaticHandler(() => <nav />));
`;
    const s = new MagicString(code);
    const registry = new Map<string, VirtualStaticHandlerEntry>();

    const result = transformInlineStaticHandlers(
      s, code, "src/urls.tsx", true, "urls.tsx", registry, "/abs/src/urls.tsx", parseAst,
    );

    expect(result).toBe(true);
    expect(registry.size).toBe(1);

    const entry = [...registry.values()][0];
    expect(entry.originalModuleId).toBe("/abs/src/urls.tsx");
    expect(entry.handlerCode).toContain("createStaticHandler");
    expect(entry.exportName).toMatch(/^__sh_[0-9a-f]{8}$/);
    expect(entry.imports).toHaveLength(1);
    expect(entry.imports[0]).toContain("@rangojs/router");

    // The transformed code should import from the virtual module
    const output = s.toString();
    expect(output).toContain(`import { ${entry.exportName} }`);
    expect(output).toContain("virtual:static-handler:");
    // The inline call should be replaced with the export name
    expect(output).toContain(`layout(${entry.exportName})`);
    expect(output).not.toContain("createStaticHandler(() => <nav />)");
  });

  it("does not extract export const calls", () => {
    const code = `import { createStaticHandler } from "@rangojs/router";
export const Nav = createStaticHandler(() => <nav />);
`;
    const s = new MagicString(code);
    const registry = new Map<string, VirtualStaticHandlerEntry>();

    const result = transformInlineStaticHandlers(
      s, code, "src/urls.tsx", true, "urls.tsx", registry, "/abs/src/urls.tsx", parseAst,
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
    const registry = new Map<string, VirtualStaticHandlerEntry>();

    const result = transformInlineStaticHandlers(
      s, code, "src/urls.tsx", true, "urls.tsx", registry, "/abs/src/urls.tsx", parseAst,
    );

    expect(result).toBe(true);
    expect(registry.size).toBe(2);

    const output = s.toString();
    // Both inline calls should be replaced
    expect(output).not.toContain("createStaticHandler(() => <nav />)");
    expect(output).not.toContain("createStaticHandler(() => <about />)");
  });

  it("extracts only inline calls from mixed file", () => {
    const code = `import { createStaticHandler } from "@rangojs/router";
export const Nav = createStaticHandler(() => <nav />);
layout(createStaticHandler(() => <sidebar />));
`;
    const s = new MagicString(code);
    const registry = new Map<string, VirtualStaticHandlerEntry>();

    const result = transformInlineStaticHandlers(
      s, code, "src/urls.tsx", true, "urls.tsx", registry, "/abs/src/urls.tsx", parseAst,
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
    const registry = new Map<string, VirtualStaticHandlerEntry>();

    transformInlineStaticHandlers(
      s, code, "src/urls.tsx", true, "urls.tsx", registry, "/abs/src/urls.tsx", parseAst,
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
    const registry = new Map<string, VirtualStaticHandlerEntry>();

    transformInlineStaticHandlers(
      s, code, "src/urls.tsx", true, "urls.tsx", registry, "/abs/src/urls.tsx", parseAst,
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
