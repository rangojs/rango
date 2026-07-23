import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { transformServerRefs } from "../plugins/server-ref-hashing.js";

function sha256_12(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

describe("transformServerRefs", () => {
  const root = "/home/user/project";

  it("returns null for code without registerServerReference", () => {
    expect(transformServerRefs("const x = 1;", root)).toBeNull();
  });

  it("rewrites a dev-style id to the production hash and leaves value + name", () => {
    // The shape plugin-rsc emits for an inline action in a dev/serve server:
    // a hoisted value, the dev-style module id, and the export name.
    const input = `$$ReactServer.registerServerReference($$hoist_0_staticInlineAction, "/src/urls/prerender.tsx", "staticInlineAction")`;

    const result = transformServerRefs(input, root)!;
    expect(result).not.toBeNull();

    const expectedHash = sha256_12("src/urls/prerender.tsx");
    expect(result).toContain(`"${expectedHash}"`);
    expect(result).not.toContain(`"/src/urls/prerender.tsx"`);
    // Value (hoisted fn) and export name (third arg) untouched.
    expect(result).toContain("$$hoist_0_staticInlineAction");
    expect(result).toContain(`, "staticInlineAction")`);
  });

  it("leaves the trailing .bind(encryptActionBoundArgs(...)) intact", () => {
    const input = `registerServerReference($$hoist_1_likeAction, "/src/urls/prerender.tsx", "likeAction").bind(null, encryptActionBoundArgs(["a1"]))`;

    const result = transformServerRefs(input, root)!;
    const expectedHash = sha256_12("src/urls/prerender.tsx");
    expect(result).toContain(`"${expectedHash}"`);
    // The bound-args payload is outside the matched call and must be preserved.
    expect(result).toContain(`.bind(null, encryptActionBoundArgs(["a1"]))`);
  });

  it("uses the same hash for multiple actions from one module", () => {
    const input = [
      `registerServerReference($$hoist_0_a, "/src/urls/prerender.tsx", "a")`,
      `registerServerReference($$hoist_1_b, "/src/urls/prerender.tsx", "b")`,
    ].join("\n");

    const result = transformServerRefs(input, root)!;
    const expectedHash = sha256_12("src/urls/prerender.tsx");
    const occurrences = result.split(`"${expectedHash}"`).length - 1;
    expect(occurrences).toBe(2);
    expect(result).not.toContain(`"/src/urls/prerender.tsx"`);
  });

  it("hashes /@fs/ ids relative to root", () => {
    const input = `registerServerReference($$h, "/@fs/home/user/project/src/urls/x.tsx", "fn")`;
    const result = transformServerRefs(input, root)!;
    expect(result).toContain(`"${sha256_12("src/urls/x.tsx")}"`);
    expect(result).not.toContain("/@fs/");
  });

  it("strips a query suffix before hashing", () => {
    const input = `registerServerReference($$h, "/src/urls/prerender.tsx?t=123", "fn")`;
    const result = transformServerRefs(input, root)!;
    expect(result).toContain(`"${sha256_12("src/urls/prerender.tsx")}"`);
    expect(result).not.toContain("?t=123");
  });

  it("returns null when ids are already production hashes", () => {
    const input = `registerServerReference($$h, "cb9e524e20f0", "fn")`;
    expect(transformServerRefs(input, root)).toBeNull();
  });
});
