/**
 * What is installed for a package the server build leaves external: the input
 * the cache versions need because the built chunk only says `from "pkg"`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInstalledPackageDescriber } from "../installed-packages.js";

let root: string;

function install(
  dir: string,
  manifest: {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    exports?: unknown;
  },
): void {
  const path = join(root, dir, "package.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest));
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "rango-installed-")));
  mkdirSync(join(root, "app"), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("createInstalledPackageDescriber", () => {
  it("names the package and everything it depends on, sorted", () => {
    install("app/node_modules/lib", {
      name: "lib",
      version: "1.2.0",
      dependencies: { dep: "^2.0.0" },
      peerDependencies: { peer: "*" },
      optionalDependencies: { missing: "*" },
    });
    install("app/node_modules/dep", {
      name: "dep",
      version: "2.3.4",
      dependencies: { leaf: "1" },
    });
    install("app/node_modules/leaf", { name: "leaf", version: "1.0.0" });
    install("app/node_modules/peer", { name: "peer", version: "9.0.0" });
    expect(createInstalledPackageDescriber(join(root, "app"))("lib")).toBe(
      "dep@2.3.4\nleaf@1.0.0\nlib@1.2.0\npeer@9.0.0",
    );
  });

  it("changes when a dependency of a dependency is bumped", () => {
    const describeLib = () => {
      install("app/node_modules/lib", {
        name: "lib",
        version: "1.0.0",
        dependencies: { dep: "*" },
      });
      return createInstalledPackageDescriber(join(root, "app"))("lib");
    };
    install("app/node_modules/dep", { name: "dep", version: "1.0.0" });
    const before = describeLib();
    install("app/node_modules/dep", { name: "dep", version: "1.0.1" });
    expect(describeLib()).not.toBe(before);
  });

  it("resolves each dependency from the package that declares it", () => {
    // Two versions of `dep`: the app's, and the one nested under `lib`.
    install("app/node_modules/dep", { name: "dep", version: "1.0.0" });
    install("app/node_modules/lib", {
      name: "lib",
      version: "1.0.0",
      dependencies: { dep: "^2" },
    });
    install("app/node_modules/lib/node_modules/dep", {
      name: "dep",
      version: "2.0.0",
    });
    expect(createInstalledPackageDescriber(join(root, "app"))("lib")).toBe(
      "dep@2.0.0\nlib@1.0.0",
    );
  });

  it("finds a package a parent directory installed, and follows a symlinked store", () => {
    // pnpm's layout: the app's node_modules links into a store whose sibling
    // directories hold the package's own dependencies.
    install("store/lib@1/node_modules/lib", {
      name: "lib",
      version: "1.0.0",
      dependencies: { dep: "*" },
      exports: { import: "./index.mjs" },
    });
    install("store/lib@1/node_modules/dep", { name: "dep", version: "3.0.0" });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    symlinkSync(
      join(root, "store/lib@1/node_modules/lib"),
      join(root, "node_modules/lib"),
      "dir",
    );
    expect(createInstalledPackageDescriber(join(root, "app"))("lib")).toBe(
      "dep@3.0.0\nlib@1.0.0",
    );
  });

  it("survives a dependency cycle", () => {
    install("app/node_modules/a", {
      name: "a",
      version: "1.0.0",
      dependencies: { b: "*" },
    });
    install("app/node_modules/b", {
      name: "b",
      version: "1.0.0",
      dependencies: { a: "*" },
    });
    expect(createInstalledPackageDescriber(join(root, "app"))("a")).toBe(
      "a@1.0.0\nb@1.0.0",
    );
  });

  it("returns undefined for a package that is not installed", () => {
    expect(
      createInstalledPackageDescriber(join(root, "app"))("nowhere"),
    ).toBeUndefined();
  });

  describe("a linked package", () => {
    /** A workspace package linked into the app, with one source file. */
    function link(body: string): void {
      install("packages/ws", { name: "ws", version: "0.0.0" });
      writeFileSync(join(root, "packages/ws/index.js"), body);
      mkdirSync(join(root, "app/node_modules"), { recursive: true });
      rmSync(join(root, "app/node_modules/ws"), {
        recursive: true,
        force: true,
      });
      symlinkSync(
        join(root, "packages/ws"),
        join(root, "app/node_modules/ws"),
        "dir",
      );
    }
    const describeWs = () =>
      createInstalledPackageDescriber(join(root, "app"))("ws");

    it("is described by its files, since its version does not fix its code", () => {
      link("export const a = 1;");
      const before = describeWs();
      expect(before).toMatch(/^ws@0\.0\.0 files:[0-9a-f]{64}$/);
      link("export const a = 2;");
      expect(describeWs()).not.toBe(before);
      link("export const a = 1;");
      expect(describeWs()).toBe(before);
    });

    it("leaves its own installs and its .git out of the digest", () => {
      link("export const a = 1;");
      const before = describeWs();
      mkdirSync(join(root, "packages/ws/node_modules/x"), { recursive: true });
      writeFileSync(join(root, "packages/ws/node_modules/x/i.js"), "1");
      mkdirSync(join(root, "packages/ws/.git"), { recursive: true });
      writeFileSync(join(root, "packages/ws/.git/HEAD"), "ref");
      expect(describeWs()).toBe(before);
    });

    // A Dirent for a symlink is neither a file nor a directory: skipped, an
    // edit behind the link changed nothing.
    it("follows a symlink to a file or a directory inside it", () => {
      link("export * from './shared/x.js';");
      mkdirSync(join(root, "elsewhere"), { recursive: true });
      writeFileSync(join(root, "elsewhere/x.js"), "export const x = 1;");
      symlinkSync(
        join(root, "elsewhere"),
        join(root, "packages/ws/shared"),
        "dir",
      );
      const before = describeWs();
      writeFileSync(join(root, "elsewhere/x.js"), "export const x = 2;");
      expect(describeWs()).not.toBe(before);
    });

    it("ends at a link back up the tree, and skips a dangling or circular one", () => {
      link("export const a = 1;");
      const before = describeWs();
      symlinkSync(join(root, "packages/ws"), join(root, "packages/ws/self"));
      symlinkSync(join(root, "gone"), join(root, "packages/ws/dangling"));
      symlinkSync("circular", join(root, "packages/ws/circular"));
      expect(describeWs()).toBe(before);
    });

    // Swallowed, the package dropped out of the version of every router
    // that reaches it through another package. (root reads any file.)
    it.skipIf(process.getuid?.() === 0)(
      "throws when one of its files cannot be read",
      () => {
        link("export const a = 1;");
        const secret = join(root, "packages/ws/secret.js");
        writeFileSync(secret, "x");
        chmodSync(secret, 0o000);
        try {
          expect(() => describeWs()).toThrow(/EACCES/);
        } finally {
          chmodSync(secret, 0o644);
        }
      },
    );
  });
});
