import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { computeProductionHash, transformClientRefs } from "../index.ts";

function sha256_12(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

describe("computeProductionHash", () => {
  const root = "/home/user/project";

  it("hashes root-relative paths (strip leading /)", () => {
    const result = computeProductionHash(root, "/src/Button.tsx");
    expect(result).toBe(sha256_12("src/Button.tsx"));
    expect(result).toHaveLength(12);
    expect(result).toMatch(/^[0-9a-f]{12}$/);
  });

  it("hashes /@fs/ absolute paths relative to root", () => {
    const result = computeProductionHash(
      root,
      "/@fs/home/user/project/src/Card.tsx",
    );
    expect(result).toBe(sha256_12("src/Card.tsx"));
  });

  it("hashes /@fs/ paths outside root with ../ prefix", () => {
    const result = computeProductionHash(root, "/@fs/home/user/shared/lib.tsx");
    expect(result).toBe(sha256_12("../shared/lib.tsx"));
  });

  it("hashes client-package-proxy IDs using the package name", () => {
    const result = computeProductionHash(
      root,
      "/@id/__x00__virtual:vite-rsc/client-package-proxy/react-icons",
    );
    expect(result).toBe(sha256_12("react-icons"));
  });

  it("hashes scoped package proxy IDs", () => {
    const result = computeProductionHash(
      root,
      "/@id/__x00__virtual:vite-rsc/client-package-proxy/@acme/ui",
    );
    expect(result).toBe(sha256_12("@acme/ui"));
  });

  it("hashes client-in-server-package-proxy IDs relative to root", () => {
    const encodedPath = encodeURIComponent(
      "/home/user/project/node_modules/foo/index.js",
    );
    const result = computeProductionHash(
      root,
      `/@id/__x00__virtual:vite-rsc/client-in-server-package-proxy/${encodedPath}`,
    );
    expect(result).toBe(sha256_12("node_modules/foo/index.js"));
  });

  it("returns already-hashed IDs unchanged", () => {
    const hash = "abc123def456";
    expect(computeProductionHash(root, hash)).toBe(hash);
  });

  it("returns unknown format IDs unchanged", () => {
    expect(computeProductionHash(root, "some-random-id")).toBe(
      "some-random-id",
    );
  });
});

describe("transformClientRefs", () => {
  const root = "/home/user/project";

  it("returns null for code without registerClientReference", () => {
    expect(transformClientRefs("const x = 1;", root)).toBeNull();
  });

  it("transforms a local file reference with throw-error proxy", () => {
    // This is the exact format @vitejs/plugin-rsc emits for a local "use client" file.
    const input = [
      `import { registerClientReference as $$rCR } from "react-server-dom-esm/server";`,
      `const $$ReactServer = { registerClientReference: $$rCR };`,
      `export const Button = $$ReactServer.registerClientReference(  () => { throw new Error("Unexpectedly client reference export '" + "Button" + "' is called on server") },  "/src/Button.tsx",  "Button");`,
    ].join("\n");

    const result = transformClientRefs(input, root)!;
    expect(result).not.toBeNull();

    const expectedHash = sha256_12("src/Button.tsx");
    expect(result).toContain(`"${expectedHash}"`);
    expect(result).not.toContain(`"/src/Button.tsx"`);
    // The export name "Button" (third arg) must be untouched
    expect(result).toContain(`,  "Button")`);
  });

  it("transforms multiple exports from a single file", () => {
    const input = [
      `export const Button = $$ReactServer.registerClientReference(  () => { throw new Error("Unexpectedly client reference export '" + "Button" + "' is called on server") },  "/src/components.tsx",  "Button");`,
      `export const Input = $$ReactServer.registerClientReference(  () => { throw new Error("Unexpectedly client reference export '" + "Input" + "' is called on server") },  "/src/components.tsx",  "Input");`,
      `export default $$ReactServer.registerClientReference(  () => { throw new Error("Unexpectedly client reference export '" + "default" + "' is called on server") },  "/src/components.tsx",  "default");`,
    ].join("\n");

    const result = transformClientRefs(input, root)!;
    expect(result).not.toBeNull();

    const expectedHash = sha256_12("src/components.tsx");
    // All three references should use the same hash (same file)
    const occurrences = result.split(`"${expectedHash}"`).length - 1;
    expect(occurrences).toBe(3);
    // No dev paths should remain
    expect(result).not.toContain(`"/src/components.tsx"`);
  });

  it("transforms /@fs/ paths for files outside project root", () => {
    const input = `export const Shared = $$ReactServer.registerClientReference(  () => { throw new Error("Unexpectedly client reference export '" + "Shared" + "' is called on server") },  "/@fs/home/user/shared/ui.tsx",  "Shared");`;

    const result = transformClientRefs(input, root)!;
    expect(result).not.toBeNull();

    const expectedHash = sha256_12("../shared/ui.tsx");
    expect(result).toContain(`"${expectedHash}"`);
    expect(result).not.toContain(`"/@fs/`);
  });

  it("transforms package proxy references", () => {
    const input = `export const IconBase = $$ReactServer.registerClientReference(  () => { throw new Error("Unexpectedly client reference export '" + "IconBase" + "' is called on server") },  "/@id/__x00__virtual:vite-rsc/client-package-proxy/react-icons",  "IconBase");`;

    const result = transformClientRefs(input, root)!;
    expect(result).not.toBeNull();

    const expectedHash = sha256_12("react-icons");
    expect(result).toContain(`"${expectedHash}"`);
    expect(result).not.toContain("client-package-proxy");
  });

  it("transforms meta-value proxy form (parenthesized expression)", () => {
    // When the RSC plugin has meta.value, it wraps it in parens instead of the throw arrow.
    const input = `export const Card = $$ReactServer.registerClientReference(  (CardImpl),  "/src/Card.tsx",  "Card");`;

    const result = transformClientRefs(input, root)!;
    expect(result).not.toBeNull();

    const expectedHash = sha256_12("src/Card.tsx");
    expect(result).toContain(`"${expectedHash}"`);
    expect(result).not.toContain(`"/src/Card.tsx"`);
  });

  it("returns null when all reference keys are already hashed", () => {
    const input = `export const Button = $$ReactServer.registerClientReference(  () => { throw new Error("err") },  "abc123def456",  "Button");`;
    expect(transformClientRefs(input, root)).toBeNull();
  });

  it("handles mixed dev and already-hashed references", () => {
    const input = [
      `export const A = $$ReactServer.registerClientReference(  () => { throw new Error("err") },  "/src/A.tsx",  "A");`,
      `export const B = $$ReactServer.registerClientReference(  () => { throw new Error("err") },  "abc123def456",  "B");`,
    ].join("\n");

    const result = transformClientRefs(input, root)!;
    expect(result).not.toBeNull();
    // A should be hashed
    expect(result).toContain(`"${sha256_12("src/A.tsx")}"`);
    expect(result).not.toContain(`"/src/A.tsx"`);
    // B should remain unchanged
    expect(result).toContain(`"abc123def456"`);
  });
});
