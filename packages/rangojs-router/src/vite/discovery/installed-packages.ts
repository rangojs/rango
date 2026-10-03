/**
 * What is installed for a package a server build leaves external.
 *
 * The node preset bundles only packages that need the React server condition
 * (plugin-rsc's `noExternal`); every other dependency stays an import the
 * deployed process resolves from node_modules. The built chunk then says
 * `from "pkg"` whichever version is installed, so a lockfile bump changes what
 * the server renders and nothing the cache versions hash
 * (discovery/build-versions.ts). This module supplies the missing input: the
 * `name@version` of the package and of everything it depends on, as installed
 * next to the project at build time.
 *
 * A registry package's code is fixed by its version. A linked package (a
 * workspace package, resolved to a directory outside node_modules) is not.
 * Vite bundles those unless the config lists one in `resolve.external`; then
 * it comes through here and its files are digested instead.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { compareStrings } from "../utils/compare-strings.js";

interface InstalledPackage {
  readonly label: string;
  readonly dependencies: readonly string[];
}

/** What a symlink points at, or nothing for a dangling or circular one: an
 *  import could not load it either. */
function linkTarget(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Digest of every file under `dir`, by relative path, skipping installs.
 * Symlinks are followed (a linked file is importable like any other); a
 * directory is entered once, so a link back up the tree ends there.
 */
function digestDirectory(dir: string): string {
  const hash = createHash("sha256");
  const entered = new Set<string>();
  const visit = (current: string, prefix: string): void => {
    const real = realpathSync(current);
    if (entered.has(real)) return;
    entered.add(real);
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      compareStrings(a.name, b.name),
    );
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(current, entry.name);
      const name = `${prefix}${entry.name}`;
      const kind = entry.isSymbolicLink() ? linkTarget(path) : entry;
      if (kind?.isDirectory()) {
        visit(path, `${name}/`);
      } else if (kind?.isFile()) {
        const bytes = readFileSync(path);
        hash.update(`${name}\0${bytes.byteLength}\0`);
        hash.update(bytes);
      }
    }
  };
  visit(dir, "");
  return hash.digest("hex");
}

/** Node's lookup for a bare specifier: the nearest node_modules holding it. */
function findPackageDir(name: string, from: string): string | undefined {
  for (let dir = from; ; ) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) {
      return realpathSync(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Returns a function describing an installed package by name: the sorted
 * `name@version` lines of the package and its transitive dependencies
 * (dependencies, optionalDependencies and peerDependencies, each resolved from
 * the package that declares it), with a digest of its files for a linked
 * one, or `undefined` when the package is not installed. Results are kept per
 * name for the life of the returned function.
 */
export function createInstalledPackageDescriber(
  projectRoot: string,
): (name: string) => string | undefined {
  const packages = new Map<string, InstalledPackage | undefined>();
  const read = (dir: string): InstalledPackage | undefined => {
    if (packages.has(dir)) return packages.get(dir);
    let manifest: any;
    try {
      manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    } catch {
      packages.set(dir, undefined);
      return undefined;
    }
    // Outside the try: a linked package whose files cannot be read must fail
    // the build, not drop out of the version.
    const linked = !dir.split(sep).includes("node_modules");
    const found: InstalledPackage = {
      label:
        `${manifest.name}@${manifest.version}` +
        (linked ? ` files:${digestDirectory(dir)}` : ""),
      dependencies: Object.keys({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      }),
    };
    packages.set(dir, found);
    return found;
  };

  // Packages share most of their dependencies (the same peers, the same
  // utilities): each lookup is done once for every package described.
  const located = new Map<string, string | undefined>();
  const locate = (name: string, from: string): string | undefined => {
    const key = `${from}\0${name}`;
    if (!located.has(key)) located.set(key, findPackageDir(name, from));
    return located.get(key);
  };

  const described = new Map<string, string | undefined>();
  return (name) => {
    if (described.has(name)) return described.get(name);
    const labels = new Set<string>();
    const seen = new Set<string>();
    const pending: Array<[name: string, from: string]> = [[name, projectRoot]];
    while (pending.length > 0) {
      const [dependency, from] = pending.pop()!;
      const dir = locate(dependency, from);
      if (dir === undefined || seen.has(dir)) continue;
      seen.add(dir);
      const installed = read(dir);
      if (!installed) continue;
      labels.add(installed.label);
      for (const next of installed.dependencies) pending.push([next, dir]);
    }
    const text = labels.size > 0 ? [...labels].sort().join("\n") : undefined;
    described.set(name, text);
    return text;
  };
}
