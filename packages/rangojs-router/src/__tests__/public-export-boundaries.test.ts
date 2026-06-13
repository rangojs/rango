import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const srcRoot = resolve(import.meta.dirname, "..");
const hostIndex = resolve(srcRoot, "host", "index.ts");
const serverEntry = resolve(srcRoot, "server.ts");
const rootIndex = resolve(srcRoot, "index.ts");
const rscEntry = resolve(srcRoot, "index.rsc.ts");

describe("public export boundaries", () => {
  // The server-only cache-tag APIs are real in the react-server entry and must
  // have matching stubs in the default entry, or non-react-server (SSR/client/
  // default) bundles that encounter the import fail at module linking.
  it("default + react-server entries both export the cache-tag APIs", () => {
    const rsc = readFileSync(rscEntry, "utf8");
    const root = readFileSync(rootIndex, "utf8");
    for (const name of ["cacheTag", "updateTag", "revalidateTag"]) {
      // Pin to the real re-export STATEMENT, not a prose comment mentioning the
      // name — otherwise deleting the export but leaving the comment passes.
      expect(rsc).toMatch(
        new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`),
      );
      expect(root).toContain(`export function ${name}(): never`); // default-entry stub
    }
  });

  it("does not expose HostRouterRegistry from the public host subpath", () => {
    const source = readFileSync(hostIndex, "utf8");
    expect(source).not.toContain("HostRouterRegistry");
  });

  it("exposes HostRouterRegistry from the internal server subpath", () => {
    const source = readFileSync(serverEntry, "utf8");
    expect(source).toContain("HostRouterRegistry");
  });
});
