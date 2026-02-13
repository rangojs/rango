import { describe, it, expect } from "vitest";
import { createVersionPlugin, createVirtualStubPlugin } from "../discover.ts";

describe("createVersionPlugin", () => {
  it("resolves the version virtual module ID", () => {
    const plugin = createVersionPlugin();
    // resolveId should return the prefixed ID for the version module
    const resolved = (plugin.resolveId as Function).call(
      { environment: { name: "rsc" } },
      "@rangojs/router:version"
    );
    expect(resolved).toBe("\0@rangojs/router:version");
  });

  it("returns null for non-version module IDs", () => {
    const plugin = createVersionPlugin();
    const resolved = (plugin.resolveId as Function).call(
      { environment: { name: "rsc" } },
      "some-other-module"
    );
    expect(resolved).toBeNull();
  });

  it("loads version content with a hex timestamp", () => {
    const plugin = createVersionPlugin();
    const content = (plugin.load as Function).call(
      { environment: { name: "rsc" } },
      "\0@rangojs/router:version"
    );
    expect(content).toMatch(/export const VERSION = "[0-9a-f]+"/);
  });

  it("returns null for non-version load IDs", () => {
    const plugin = createVersionPlugin();
    const content = (plugin.load as Function).call(
      { environment: { name: "rsc" } },
      "\0some-other-module"
    );
    expect(content).toBeNull();
  });
});

describe("createVirtualStubPlugin", () => {
  it("stubs virtual:rsc-router/ prefixed modules", () => {
    const plugin = createVirtualStubPlugin();
    const resolved = (plugin.resolveId as Function).call(
      {},
      "virtual:rsc-router/routes-manifest"
    );
    expect(resolved).toBe("\0stub:virtual:rsc-router/routes-manifest");

    const content = (plugin.load as Function).call(
      {},
      "\0stub:virtual:rsc-router/routes-manifest"
    );
    expect(content).toBe("export default {}");
  });

  it("stubs virtual:entry- prefixed modules", () => {
    const plugin = createVirtualStubPlugin();
    const resolved = (plugin.resolveId as Function).call(
      {},
      "virtual:entry-client"
    );
    expect(resolved).toBe("\0stub:virtual:entry-client");
  });

  it("stubs virtual:vite-rsc/ prefixed modules", () => {
    const plugin = createVirtualStubPlugin();
    const resolved = (plugin.resolveId as Function).call(
      {},
      "virtual:vite-rsc/something"
    );
    expect(resolved).toBe("\0stub:virtual:vite-rsc/something");
  });

  it("does not stub non-matching module IDs", () => {
    const plugin = createVirtualStubPlugin();
    const resolved = (plugin.resolveId as Function).call(
      {},
      "@rangojs/router/server"
    );
    expect(resolved).toBeNull();
  });

  it("returns null for non-stub load IDs", () => {
    const plugin = createVirtualStubPlugin();
    const content = (plugin.load as Function).call(
      {},
      "regular-module"
    );
    expect(content).toBeNull();
  });
});
