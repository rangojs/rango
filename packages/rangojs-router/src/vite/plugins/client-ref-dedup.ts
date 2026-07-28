import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";
import { createRangoDebugger, NS } from "../debug.js";

const debug = createRangoDebugger(NS.transform);

const CLIENT_IN_SERVER_PROXY_PREFIX =
  "virtual:vite-rsc/client-in-server-package-proxy/";
const DEDUP_PREFIX = "\0rango:dedup/";

interface PackageMetadata {
  root: string;
  selfName: string;
  exports: unknown;
}

type PackageResolver = ReturnType<ResolvedConfig["createResolver"]>;

/**
 * Extract the bare package name from an absolute node_modules path.
 * Handles scoped packages (@org/name) and nested node_modules.
 * Returns null if the path doesn't contain a valid package reference.
 *
 * See: https://github.com/cloudflare/vinext/pull/413
 */
export function extractPackageName(absolutePath: string): string | null {
  // Find the last /node_modules/ segment (handles nested node_modules)
  const marker = "/node_modules/";
  const idx = absolutePath.lastIndexOf(marker);
  if (idx === -1) return null;

  const afterModules = absolutePath.slice(idx + marker.length);

  if (afterModules.startsWith("@")) {
    // Scoped package: @org/name
    const parts = afterModules.split("/");
    if (parts.length < 2 || !parts[1]) return null;
    return `${parts[0]}/${parts[1]}`;
  }

  // Unscoped package: name
  const name = afterModules.split("/")[0];
  return name || null;
}

function stripQueryAndHash(id: string): string {
  const suffixIndex = id.search(/[?#]/);
  return suffixIndex === -1 ? id : id.slice(0, suffixIndex);
}

function getPackageRoot(source: string): string | undefined {
  const packageName = extractPackageName(source);
  if (!packageName) return;

  const marker = "/node_modules/";
  const markerIndex = source.lastIndexOf(marker);
  return source.slice(0, markerIndex + marker.length) + packageName;
}

function readPackageMetadata(
  source: string,
  cache: Map<string, PackageMetadata | null>,
): PackageMetadata | undefined {
  const root = getPackageRoot(source);
  if (!root) return;

  const cached = cache.get(root);
  if (cached !== undefined) return cached ?? undefined;

  const packageJsonPath = join(root, "package.json");
  if (!existsSync(packageJsonPath)) {
    cache.set(root, null);
    return;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: unknown;
      exports?: unknown;
    };
    if (typeof packageJson.name !== "string" || !packageJson.name) {
      cache.set(root, null);
      return;
    }
    const metadata = {
      root,
      selfName: packageJson.name,
      exports: packageJson.exports,
    } satisfies PackageMetadata;
    cache.set(root, metadata);
    return metadata;
  } catch {
    cache.set(root, null);
    return;
  }
}

function collectStringTargets(value: unknown, targets: string[]): void {
  if (typeof value === "string") {
    targets.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringTargets(item, targets);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const target of Object.values(value)) {
    collectStringTargets(target, targets);
  }
}

function singleStarParts(value: string): [string, string] | undefined {
  const starIndex = value.indexOf("*");
  if (starIndex === -1 || value.indexOf("*", starIndex + 1) !== -1) return;
  return [value.slice(0, starIndex), value.slice(starIndex + 1)];
}

function targetCanMapToSource(target: string, sourceRelative: string): boolean {
  const targetStar = singleStarParts(target);
  if (!targetStar) return target === sourceRelative;
  const [prefix, suffix] = targetStar;
  return (
    sourceRelative.startsWith(prefix) &&
    sourceRelative.endsWith(suffix) &&
    sourceRelative.length >= prefix.length + suffix.length
  );
}

function getPublicSpecifierCandidates(
  metadata: PackageMetadata,
  packageSpecifier: string,
  source: string,
): string[] {
  if (
    typeof metadata.exports !== "object" ||
    metadata.exports === null ||
    Array.isArray(metadata.exports)
  ) {
    return [];
  }

  const candidates = new Set<string>();
  const sourceRelative = `./${relative(metadata.root, source).replaceAll("\\", "/")}`;
  if (
    sourceRelative.startsWith("./../") ||
    isAbsolute(sourceRelative.slice(2))
  ) {
    return [];
  }

  for (const [exportKey, target] of Object.entries(metadata.exports)) {
    if (!exportKey.startsWith("./") || exportKey === ".") continue;

    const keyStar = singleStarParts(exportKey);
    if (!keyStar) {
      const targets: string[] = [];
      collectStringTargets(target, targets);
      if (
        targets.some((target) => targetCanMapToSource(target, sourceRelative))
      ) {
        candidates.add(`${packageSpecifier}${exportKey.slice(1)}`);
      }
      continue;
    }

    const captures = new Set<string>();
    const targets: string[] = [];
    collectStringTargets(target, targets);
    for (const targetPattern of targets) {
      const targetStar = singleStarParts(targetPattern);
      if (!targetStar) continue;
      const [prefix, suffix] = targetStar;
      if (
        !sourceRelative.startsWith(prefix) ||
        !sourceRelative.endsWith(suffix) ||
        sourceRelative.length < prefix.length + suffix.length
      ) {
        continue;
      }
      captures.add(
        sourceRelative.slice(
          prefix.length,
          sourceRelative.length - suffix.length,
        ),
      );
    }

    if (captures.size === 1) {
      const capture = captures.values().next().value;
      if (capture !== undefined) {
        const publicSubpath = `${keyStar[0]}${capture}${keyStar[1]}`;
        candidates.add(`${packageSpecifier}${publicSubpath.slice(1)}`);
      }
    }
  }

  return [...candidates];
}

function belongsToPackage(resolvedId: string, packageRoot: string): boolean {
  return normalize(getPackageRoot(resolvedId) ?? "") === normalize(packageRoot);
}

async function resolvePublicSpecifier(
  source: string,
  metadata: PackageMetadata,
  installedSpecifier: string,
  resolvePackage: PackageResolver,
  importer: string,
): Promise<string | undefined> {
  const packageSpecifiers =
    installedSpecifier === metadata.selfName
      ? [installedSpecifier]
      : [installedSpecifier, metadata.selfName];

  for (const packageSpecifier of packageSpecifiers) {
    for (const candidate of getPublicSpecifierCandidates(
      metadata,
      packageSpecifier,
      source,
    )) {
      try {
        const resolved = await resolvePackage(candidate, importer);
        if (!resolved) continue;
        const resolvedId = stripQueryAndHash(resolved);
        if (
          normalize(resolvedId) === normalize(source) &&
          belongsToPackage(resolvedId, metadata.root)
        ) {
          return candidate;
        }
      } catch {
        continue;
      }
    }

    // Fallback: the pre-exports-map behavior, and it is LOSSY. When no public
    // subpath maps back to this exact file, re-export from the bare package
    // root — correct only for packages that barrel-export their "use client"
    // symbols from the entry point (the common component-library shape).
    // A deep module whose symbols are NOT re-exported from the root loses
    // them silently after this rewrite; the exports-map resolution above
    // exists precisely to make that case rare.
    try {
      const rootResolved = await resolvePackage(packageSpecifier, importer);
      if (
        rootResolved &&
        belongsToPackage(stripQueryAndHash(rootResolved), metadata.root)
      ) {
        return packageSpecifier;
      }
    } catch {
      continue;
    }
  }
}

/**
 * Vite plugin that deduplicates client references from third-party packages
 * in dev mode.
 *
 * When @vitejs/plugin-rsc encounters a "use client" submodule inside a
 * package imported from a server component, it creates a
 * client-in-server-package-proxy virtual module that re-exports from the
 * absolute file path. In the client environment, this absolute path bypasses
 * Vite's pre-bundling, while direct client imports of the same package go
 * through .vite/deps/. Two separate module instances are created, breaking
 * React contexts (createContext runs twice, provider/consumer mismatch).
 *
 * This plugin intercepts absolute node_modules imports from proxy modules
 * in the client environment and rewrites them to bare specifier imports
 * that go through pre-bundling, ensuring a single module instance.
 *
 * Dev-only: production builds use the SSR manifest which handles module
 * identity correctly.
 */
export function clientRefDedup(): Plugin {
  let clientExclude: string[] = [];
  let rootImporter = "";
  let resolvePackage: PackageResolver | undefined;
  const dedupedPackages = new Set<string>();
  const packageMetadataCache = new Map<string, PackageMetadata | null>();
  const publicSpecifierCache = new Map<string, Promise<string | undefined>>();

  return {
    name: "@rangojs/router:client-ref-dedup",
    enforce: "pre",
    apply: "serve",

    configResolved(config: ResolvedConfig) {
      const clientEnv = config.environments?.["client"];
      clientExclude =
        clientEnv?.optimizeDeps?.exclude ?? config.optimizeDeps?.exclude ?? [];
      rootImporter = join(config.root, "index.html");
      resolvePackage = config.createResolver({ scan: true });
    },

    buildEnd() {
      if (debug && dedupedPackages.size > 0) {
        debug(
          "client-ref-dedup: redirected %d package(s) (%s)",
          dedupedPackages.size,
          [...dedupedPackages].join(","),
        );
      }
    },

    resolveId(source, importer, options) {
      if (this.environment?.name !== "client") return;

      if (!importer?.includes(CLIENT_IN_SERVER_PROXY_PREFIX)) return;

      if (!source.includes("/node_modules/")) return;

      const cleanSource = stripQueryAndHash(source);
      const packageName = extractPackageName(cleanSource);
      if (!packageName || !resolvePackage) return;

      if (clientExclude.includes(packageName)) return;

      const metadata = readPackageMetadata(cleanSource, packageMetadataCache);
      if (!metadata || clientExclude.includes(metadata.selfName)) return;

      let specifierPromise = publicSpecifierCache.get(cleanSource);
      if (!specifierPromise) {
        specifierPromise = resolvePublicSpecifier(
          cleanSource,
          metadata,
          packageName,
          resolvePackage,
          rootImporter,
        );
        publicSpecifierCache.set(cleanSource, specifierPromise);
        // Only SUCCESSFUL resolutions stay cached. A failed one is evicted so
        // the next resolveId retries — deliberate: dev-time failures can be
        // transient (a dependency installed mid-session, an exports map fixed
        // on disk). The cost is a repeated candidate scan per unresolvable
        // module, bounded by resolveId call frequency in dev.
        void specifierPromise.then(
          (specifier) => {
            if (
              !specifier &&
              publicSpecifierCache.get(cleanSource) === specifierPromise
            ) {
              publicSpecifierCache.delete(cleanSource);
            }
          },
          () => {
            if (publicSpecifierCache.get(cleanSource) === specifierPromise) {
              publicSpecifierCache.delete(cleanSource);
            }
          },
        );
      }

      return specifierPromise.then((specifier) => {
        if (!specifier) return;
        if (debug) dedupedPackages.add(packageName);
        return `${DEDUP_PREFIX}${encodeURIComponent(specifier)}`;
      });
    },

    load(id) {
      if (!id.startsWith(DEDUP_PREFIX)) return;

      let specifier: string;
      try {
        specifier = decodeURIComponent(id.slice(DEDUP_PREFIX.length));
      } catch {
        return;
      }

      return [
        `export * from ${JSON.stringify(specifier)};`,
        `import * as __all__ from ${JSON.stringify(specifier)};`,
        `export default __all__.default;`,
      ].join("\n");
    },
  };
}
