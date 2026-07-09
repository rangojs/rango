import { describe, expect, it } from "vitest";
import { getVendorAliases } from "../utils/package-resolution.js";

describe("getVendorAliases", () => {
  it("resolves every plugin-rsc vendor entry injected into optimizeDeps", () => {
    const aliases = getVendorAliases();

    expect(aliases).toHaveProperty(
      "@vitejs/plugin-rsc/vendor/react-server-dom/client.browser",
    );
    expect(aliases).toHaveProperty(
      "@vitejs/plugin-rsc/vendor/react-server-dom/client.edge",
    );
    expect(aliases).toHaveProperty(
      "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge",
    );
  });
});
