import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { PublicRequestContext } from "../server/request-context.js";

type InternalOnlyContextKey =
  | "_pendingBackgroundTasks"
  | "_shellCaptureLoaderHandleValues"
  | "_shellCaptureGuardTripped"
  | "_tracing";

const publicContextHidesInternalFields: Extract<
  keyof PublicRequestContext,
  InternalOnlyContextKey
> extends never
  ? true
  : false = true;

/**
 * Names exported by an entry module's `export {}` / `export type {}` lists and
 * top-level `export type|interface` declarations. With `typesOnly`, only
 * type-position exports; otherwise values too (function/const/class).
 */
function exportedNames(source: string, typesOnly: boolean): Set<string> {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const names = new Set<string>();
  for (const [, typeKeyword, list] of code.matchAll(
    /export\s+(type\s+)?\{([^}]*)\}/g,
  )) {
    for (const raw of list.split(",")) {
      const item = raw.trim();
      if (!item) continue;
      if (typesOnly && !typeKeyword && !item.startsWith("type ")) continue;
      names.add(
        item
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)
          .pop()!
          .trim(),
      );
    }
  }
  for (const [, , name] of code.matchAll(
    /export\s+(?:declare\s+)?(type|interface)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    names.add(name);
  }
  if (!typesOnly) {
    for (const [, name] of code.matchAll(
      /export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g,
    )) {
      names.add(name);
    }
  }
  return names;
}

const srcRoot = resolve(import.meta.dirname, "..");
const hostIndex = resolve(srcRoot, "host", "index.ts");
const serverEntry = resolve(srcRoot, "server.ts");
const rootIndex = resolve(srcRoot, "index.ts");
const rscEntry = resolve(srcRoot, "index.rsc.ts");

describe("public export boundaries", () => {
  it("keeps internal-only fields out of the public request context type", () => {
    expect(publicContextHidesInternalFields).toBe(true);
  });

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

  it("default + react-server entries both export TRACKING_SEARCH_PARAMS", () => {
    const rsc = readFileSync(rscEntry, "utf8");
    const root = readFileSync(rootIndex, "utf8");
    for (const source of [rsc, root]) {
      expect(source).toMatch(
        /export\s*\{[^}]*\bTRACKING_SEARCH_PARAMS\b[^}]*\}\s*from/,
      );
    }
  });

  // The root `types` condition resolves to index.rsc.d.ts, so a type exported
  // only from index.ts is invisible to installed consumers. The two export
  // lists are maintained by hand (LoaderOptions drifted this way).
  it("react-server entry exports every type the default entry exports", () => {
    const rscNames = exportedNames(readFileSync(rscEntry, "utf8"), false);
    const missing = [
      ...exportedNames(readFileSync(rootIndex, "utf8"), true),
    ].filter((name) => !rscNames.has(name));
    expect(missing).toEqual([]);
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
