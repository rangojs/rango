import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveImportedVariable,
  buildCombinedRouteMapWithSearch,
  type UnresolvableInclude,
} from "../route-types/include-resolution.js";

// E2: an include() target imported via a combined default+named import
// (`import Foo, { bar } from "..."`) must resolve. The import scanner regex
// previously required `{` to follow `import` with only whitespace, so the
// leading default binding broke the match and the target surfaced as a false
// `unresolvable-import` diagnostic (which hard-errors in CLI default mode).

describe("resolveImportedVariable (E2): default+named import forms", () => {
  it("resolves a named member when a default binding precedes it", () => {
    const code = `import schema, { apiRoutes } from "./api/urls";`;
    expect(resolveImportedVariable(code, "apiRoutes")).toEqual({
      specifier: "./api/urls",
      exportedName: "apiRoutes",
    });
  });

  it("resolves an aliased named member after a default binding", () => {
    const code = `import schema, { apiRoutes as api } from "./api/urls";`;
    expect(resolveImportedVariable(code, "api")).toEqual({
      specifier: "./api/urls",
      exportedName: "apiRoutes",
    });
  });

  it("still resolves a plain named import (no default binding)", () => {
    const code = `import { apiRoutes } from "./api/urls";`;
    expect(resolveImportedVariable(code, "apiRoutes")).toEqual({
      specifier: "./api/urls",
      exportedName: "apiRoutes",
    });
  });

  it("still resolves a brace-tight import (`import{x}`)", () => {
    const code = `import{apiRoutes}from"./api/urls";`;
    expect(resolveImportedVariable(code, "apiRoutes")).toEqual({
      specifier: "./api/urls",
      exportedName: "apiRoutes",
    });
  });
});

describe("include() of a default+named import (E2 end-to-end)", () => {
  it("resolves without a false unresolvable-import diagnostic", () => {
    const dir = mkdtempSync(join(tmpdir(), "rango-e2-"));
    try {
      // Child module: a urls() default-exported plus a named urls() block.
      writeFileSync(
        join(dir, "api.ts"),
        `import { urls, path } from "@rangojs/router";
export default urls(() => {
  path("/health");
});
export const apiRoutes = urls(() => {
  path("/users", { name: "users" });
});
`,
      );
      // Parent module includes the named member via a default+named import.
      writeFileSync(
        join(dir, "urls.ts"),
        `import { urls, include } from "@rangojs/router";
import schema, { apiRoutes } from "./api";
export const appRoutes = urls(() => {
  include("/api", apiRoutes, { name: "api" });
});
`,
      );

      const diagnostics: UnresolvableInclude[] = [];
      const result = buildCombinedRouteMapWithSearch(
        join(dir, "urls.ts"),
        "appRoutes",
        undefined,
        diagnostics,
      );

      // No false hard-error: the include target resolves.
      expect(
        diagnostics.filter((d) => d.reason === "unresolvable-import"),
      ).toHaveLength(0);
      // The named child route is mounted under the include prefix.
      expect(result.routes["api.users"]).toBe("/api/users");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
