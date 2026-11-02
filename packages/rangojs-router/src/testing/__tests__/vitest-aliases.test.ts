import { describe, expect, it } from "vitest";
import { rangoTestAliases } from "../vitest.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

describe("rangoTestAliases plugin-rsc browser", () => {
  it("aliases the browser entry to the stub renderRoute answers loads through", () => {
    // useLoader().load() decodes its answer with createFromFetch from this
    // entry; the real one imports a Vite virtual a bare Vitest cannot resolve.
    const browser = rangoTestAliases().find(
      (a) =>
        a.find instanceof RegExp && a.find.test("@vitejs/plugin-rsc/browser"),
    );
    expect(browser).toBeDefined();
    expect(browser!.replacement).toMatch(
      /testing[/\\]vitest-stubs[/\\]plugin-rsc-browser\.ts$/,
    );
  });

  it("is the file the package's own vitest.config.ts aliases", () => {
    const kit = rangoTestAliases().find(
      (a) =>
        a.find instanceof RegExp && a.find.test("@vitejs/plugin-rsc/browser"),
    );
    const config = readFileSync(
      resolve(__dirname, "../../../vitest.config.ts"),
      "utf8",
    );
    const own = config.match(
      /"@vitejs\/plugin-rsc\/browser":\s*resolve\(\s*__dirname,\s*"([^"]+)"/,
    );
    expect(own).not.toBeNull();
    expect(resolve(__dirname, "../../../", own![1]!)).toBe(kit!.replacement);
  });
});
