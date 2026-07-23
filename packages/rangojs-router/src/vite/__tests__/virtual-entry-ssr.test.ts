import { describe, it, expect } from "vitest";
import { parseAstAsync } from "vite";
import {
  getVirtualEntrySSR,
  VIRTUAL_ENTRY_BROWSER,
} from "../plugins/virtual-entries.js";

describe("virtual browser entry", () => {
  it("loads the dev discovery handshake only inside the hot branch", () => {
    expect(VIRTUAL_ENTRY_BROWSER).not.toMatch(
      /^import .*internal\/browser\/dev-discovery/m,
    );
    expect(VIRTUAL_ENTRY_BROWSER).toContain(
      'await import(\n      "@rangojs/router/internal/browser/dev-discovery"',
    );
  });
});

describe("getVirtualEntrySSR headScripts wiring", () => {
  it('default ("preinit") installs the client-reference preinit hook', () => {
    const entry = getVirtualEntrySSR();
    expect(entry).toContain(
      "installClientReferencePreinit(setOnClientReference)",
    );
    expect(entry).toContain('headScripts: "preinit"');
  });

  it('"preload" omits the hook and pins the handlers to the hint strategy', () => {
    const entry = getVirtualEntrySSR("preload");
    expect(entry).not.toContain("installClientReferencePreinit");
    expect(entry).not.toContain("setOnClientReference");
    expect(entry).toContain('headScripts: "preload"');
  });

  it("threads headScripts into all three SSR handler factories", () => {
    for (const mode of ["preinit", "preload"] as const) {
      const entry = getVirtualEntrySSR(mode);
      const marker = `headScripts: ${JSON.stringify(mode)}`;
      expect(entry.split(marker).length - 1).toBe(3);
    }
  });

  it("both generated variants parse as valid modules", async () => {
    // The preload variant is compiled by no in-repo app (every fixture runs
    // the default), so a splice error confined to it would otherwise ship
    // green and first surface as a virtual-module parse failure in the
    // consumer's build. Substring checks can't catch that; a real parse can.
    for (const mode of ["preinit", "preload"] as const) {
      await expect(
        parseAstAsync(getVirtualEntrySSR(mode)),
        `getVirtualEntrySSR("${mode}") parses`,
      ).resolves.toBeTruthy();
    }
  });
});
