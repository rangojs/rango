import { describe, it, expect } from "vitest";
import { hasUseClientDirective } from "../rango";

// E8: the client-component-hmr 'use client' sniff must tolerate a leading
// comment/whitespace before the directive (the AST-based version plugin does),
// so editing a 'use client' file that opens with a license banner / @ts-nocheck
// does not fall through to plugin-rsc's full-reload HMR.

describe("hasUseClientDirective (E8)", () => {
  it("detects a bare leading directive (double quotes)", () => {
    expect(hasUseClientDirective(`"use client";\nexport const x = 1;`)).toBe(
      true,
    );
  });

  it("detects a bare leading directive (single quotes)", () => {
    expect(hasUseClientDirective(`'use client';\nexport const x = 1;`)).toBe(
      true,
    );
  });

  it("detects a directive preceded by a leading line comment", () => {
    const src = `// @ts-nocheck\n"use client";\nexport const x = 1;`;
    expect(hasUseClientDirective(src)).toBe(true);
  });

  it("detects a directive preceded by a leading block comment (license banner)", () => {
    const src = `/* Copyright 2026\n * banner\n */\n"use client";\nexport const x = 1;`;
    expect(hasUseClientDirective(src)).toBe(true);
  });

  it("returns false for a module without the directive", () => {
    expect(hasUseClientDirective(`export const x = 1;`)).toBe(false);
  });

  it("returns false when 'use client' is not a leading directive", () => {
    // Preceded by a real statement -> not a directive prologue.
    const src = `const a = 1;\n"use client";\n`;
    expect(hasUseClientDirective(src)).toBe(false);
  });

  it("returns false (not a crash) on unparseable source", () => {
    expect(hasUseClientDirective(`const = = =`)).toBe(false);
  });
});
