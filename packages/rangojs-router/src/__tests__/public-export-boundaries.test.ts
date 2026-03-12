import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const srcRoot = resolve(import.meta.dirname, "..");
const hostIndex = resolve(srcRoot, "host", "index.ts");
const serverEntry = resolve(srcRoot, "server.ts");

describe("public export boundaries", () => {
  it("does not expose HostRouterRegistry from the public host subpath", () => {
    const source = readFileSync(hostIndex, "utf8");
    expect(source).not.toContain("HostRouterRegistry");
  });

  it("exposes HostRouterRegistry from the internal server subpath", () => {
    const source = readFileSync(serverEntry, "utf8");
    expect(source).toContain("HostRouterRegistry");
  });
});
