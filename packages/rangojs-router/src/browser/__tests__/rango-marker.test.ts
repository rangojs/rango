// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_VERSION } from "@rangojs/router:version";
import { publishRangoMarker } from "../rango-marker.js";
import {
  getVirtualBuildVersionContent,
  getVirtualPackageVersionContent,
  getVirtualVersionContent,
} from "../../vite/plugins/virtual-entries.js";
import packageJson from "../../../package.json";

const SRC = resolve(__dirname, "../..");

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "__tests__") continue;
      out.push(...listSources(full));
    } else if (/\.(ts|tsx|mjs|js)$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("window.__rango marker", () => {
  it("publishes a frozen { version } with exactly one key", () => {
    publishRangoMarker();
    const marker = (window as unknown as { __rango: unknown }).__rango;
    expect(marker).toEqual({ version: PACKAGE_VERSION });
    expect(Object.keys(marker as object)).toEqual(["version"]);
    expect(Object.isFrozen(marker)).toBe(true);
  });

  it("serves the router's package.json version from every virtual module shape", () => {
    const expected = `export const PACKAGE_VERSION = ${JSON.stringify(packageJson.version)};`;
    expect(getVirtualPackageVersionContent()).toBe(expected);
    expect(getVirtualVersionContent("dev")).toContain(expected);
    expect(getVirtualBuildVersionContent()).toContain(expected);
  });

  it("is write-only: no router source reads window.__rango", () => {
    const hits: string[] = [];
    for (const file of listSources(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/\b__rango\b/.test(line)) return;
        // The one write site: `(window as ...).__rango = Object.freeze(`.
        if (/\.__rango\s*=\s*Object\.freeze\(/.test(line)) return;
        // Type annotation of the write cast.
        if (/\{\s*__rango\?:\s*unknown\s*\}/.test(line)) return;
        // Comments and docs mentioning the name.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        hits.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
