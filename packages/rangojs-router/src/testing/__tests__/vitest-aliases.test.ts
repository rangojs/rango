import { describe, expect, it } from "vitest";
import { rangoTestAliases } from "../vitest.js";

describe("rangoTestAliases plugin-rsc vendor", () => {
  it("aliases vendor/server.edge to the copy resolved from @rangojs/router", () => {
    // rangoUseClientTransform injects this specifier into consumer "use client"
    // modules. A consumer app does not depend on @vitejs/plugin-rsc, so the
    // alias must point at the file this package can resolve.
    const aliases = rangoTestAliases();
    const vendor = aliases.find(
      (a) =>
        a.find === "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge",
    );
    expect(vendor).toBeDefined();
    expect(vendor!.replacement).toMatch(/server\.edge/);
  });
});
