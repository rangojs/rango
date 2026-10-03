/**
 * Post-build cache version phase.
 *
 * Runs from the buildApp post hook, after every environment bundle is written
 * and postprocessBundle has rewritten the RSC chunks, and before the shell
 * capture phase, which stamps its entries with the document versions computed
 * here. Reads the bytes that ship, computes each router's versions
 * (build-versions.ts) and writes the table into the built
 * `@rangojs/router:version` module in place of its placeholder.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_ROUTER_VERSIONS_KEY,
  type RouterVersionsTable,
} from "../../router-versions.js";
import { isEncryptionKeyStable } from "../encryption-key.js";
import { createRangoDebugger, NS } from "../debug.js";
import {
  defaultExportProperties,
  literalProperties,
} from "../plugins/stable-rsc-output.js";
import { RANGO_BUILD_DIR } from "../utils/prerender-utils.js";
import {
  computeRouterVersions,
  digestDocumentInputs,
  externalPackage,
  fillRouterVersions,
  isSourceMap,
  portableModuleId,
  sha256,
  type BuildDataRecord,
  type RouterVersionDetail,
} from "./build-versions.js";
import { createInstalledPackageDescriber } from "./installed-packages.js";
import type { DiscoveryState } from "./state.js";

const debug = createRangoDebugger(NS.build);

/** plugin-rsc's client asset manifest, written into the SSR and RSC out dirs. */
const ASSETS_MANIFEST_FILE = "__vite_rsc_assets_manifest.js";
const EMPTY_SERVER_RESOURCES = /"serverResources":\s*\{\s*\}/;

/** Minimal builder surface the post-build phases read. */
export interface BuilderLike {
  config?: { base?: string };
  environments?: Record<
    string,
    { config?: { build?: { outDir?: string } } } | undefined
  >;
}

/**
 * An environment's output directory, or Vite's default layout without one.
 * Resolved against the root: a relative `build.outDir` is relative to it, not
 * to the directory `vite build <root>` was run from.
 */
export function environmentOutDir(
  builder: BuilderLike | undefined,
  projectRoot: string,
  environment: string,
): string {
  return resolve(
    projectRoot,
    builder?.environments?.[environment]?.config?.build?.outDir ??
      join("dist", environment),
  );
}

/**
 * Where the build leaves what each version was computed from. Outside the
 * output directories, so it never ships.
 */
export const VERSIONS_REPORT_FILE: string = `${RANGO_BUILD_DIR}/cache-versions.json`;

function readIfPresent(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch (err: any) {
    if (err?.code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * The `serverResources` map of plugin-rsc's assets manifest
 * (`export default { ..., serverResources: { "<module>": { js, css } } }`):
 * each server module that imports CSS, to the source text of its entry. Text,
 * not a parsed value: with `renderBuiltUrl` an entry holds runtime expressions.
 * Throws when the manifest is not that shape, so a plugin-rsc that moves it
 * fails the build instead of dropping stylesheets from the versions.
 */
export function readServerResources(manifest: string): Map<string, string> {
  // Most apps import no CSS from a server component: skip parsing a manifest
  // that lists every client reference. (Inside a JSON string the quotes would
  // be escaped, so this text can only be the property itself.)
  if (EMPTY_SERVER_RESOURCES.test(manifest)) return new Map();
  const entries = literalProperties(
    defaultExportProperties(manifest)?.find(
      (property) => property.key === "serverResources",
    )?.value,
  );
  if (!entries) {
    throw new Error(
      `${ASSETS_MANIFEST_FILE} has no serverResources object literal: the installed ` +
        `@vitejs/plugin-rsc writes a manifest @rangojs/router cannot read. ` +
        `Report it with the plugin-rsc version.`,
    );
  }
  return new Map(
    entries.map((entry) => [
      entry.key,
      manifest.slice(entry.value.start, entry.value.end),
    ]),
  );
}

/**
 * One record per clientUrls() module: the projection the server materializes
 * the group from. The map holds it under each of the module's reference ids.
 */
function clientUrlRecords(s: DiscoveryState): BuildDataRecord[] {
  const projectionOf = new Map<string, string>();
  for (const [referenceId, projection] of s.clientUrlProjectionMap ?? []) {
    projectionOf.set(
      s.clientUrlSourceByReferenceId?.get(referenceId) ?? referenceId,
      JSON.stringify(projection),
    );
  }
  return [...projectionOf].map(([source, projection]) => ({
    kind: "client-urls",
    key: portableModuleId(source, s.projectRoot),
    digest: sha256(projection),
    moduleId: source,
  }));
}

/**
 * Write every version's inputs as `name: digest`. A version is one hash, so a
 * changed version says nothing about what changed; diffing two builds' reports
 * names the file, payload or key that did.
 */
function writeVersionsReport(
  projectRoot: string,
  details: readonly RouterVersionDetail[],
  sourceOf: ReadonlyMap<string, string>,
): void {
  const report: Record<string, unknown> = {};
  for (const detail of details) {
    report[detail.routerId] = {
      source: sourceOf.get(detail.routerId) ?? "",
      data: detail.data,
      document: detail.document,
      dataInputs: Object.fromEntries(detail.dataInputs),
      documentInputs: Object.fromEntries(detail.documentInputs),
    };
  }
  try {
    const path = resolve(projectRoot, VERSIONS_REPORT_FILE);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
  } catch (err: any) {
    debug?.("could not write %s: %s", VERSIONS_REPORT_FILE, err?.message);
  }
}

export function runRouterVersionsPhase(
  s: DiscoveryState,
  builder: BuilderLike | undefined,
): void {
  if (!s.isBuildMode) return;
  const server = s.serverBuildGraph;
  // The built version module holds a placeholder only this phase replaces: a
  // build that skipped it would throw a ReferenceError on its first import.
  if (!server) {
    throw new Error(
      "[rango] The RSC build did not record its bundle, so the cache versions cannot be computed. " +
        "This is a bug in @rangojs/router; please report it.",
    );
  }

  const start = performance.now();
  const rscOutDir = environmentOutDir(builder, s.projectRoot, "rsc");
  const ssrOutDir = environmentOutDir(builder, s.projectRoot, "ssr");

  let table: RouterVersionsTable;
  let details: readonly RouterVersionDetail[];
  // A dependency the build cannot find cannot be shown unchanged: it is
  // described by a value unique to this build, so the routers importing it
  // get a new version, and the build says which packages (below).
  const notFound = new Set<string>();
  const describeInstalled = createInstalledPackageDescriber(s.projectRoot);
  const buildId = randomUUID();
  const describeExternal = (name: string): string => {
    const installed = describeInstalled(name);
    if (installed !== undefined) return installed;
    notFound.add(name);
    return `not found, build ${buildId}`;
  };
  try {
    const ssrFiles: Array<{ fileName: string; source: Uint8Array }> = [];
    for (const fileName of new Set([
      ...(s.ssrBundle?.fileNames ?? []),
      ASSETS_MANIFEST_FILE,
    ])) {
      if (isSourceMap(fileName)) continue;
      const source = readIfPresent(join(ssrOutDir, fileName));
      if (source !== undefined) ssrFiles.push({ fileName, source });
    }
    const ssrExternals: Array<[string, string]> = [];
    for (const name of new Set(
      (s.ssrBundle?.externalImports ?? []).flatMap(
        (specifier) => externalPackage(specifier) ?? [],
      ),
    )) {
      ssrExternals.push([name, describeExternal(name)]);
    }
    const assetsManifest = readIfPresent(join(rscOutDir, ASSETS_MANIFEST_FILE));
    ({ table, details } = computeRouterVersions({
      projectRoot: s.projectRoot,
      server,
      client: s.clientBuildGraph ?? undefined,
      routers: s.perRouterManifests.map((entry) => ({
        id: entry.id,
        moduleId: entry.sourceFile,
      })),
      buildData: [...s.buildData, ...clientUrlRecords(s)],
      readServerFile: (fileName) => readIfPresent(join(rscOutDir, fileName)),
      documentDigest: digestDocumentInputs({
        ssrFiles,
        clientFileNames: s.clientBuildGraph?.fileNames ?? [],
        base: builder?.config?.base ?? "/",
        ssrExternals,
      }),
      serverResources: assetsManifest
        ? readServerResources(assetsManifest.toString("utf-8"))
        : undefined,
      describeExternal,
    }));
  } catch (err: any) {
    throw new Error(
      `[rango] Could not compute the cache versions: ${err?.message ?? err}`,
      { cause: err },
    );
  }

  for (const [environment, fileNames] of s.versionModuleFiles) {
    const outDir = environmentOutDir(builder, s.projectRoot, environment);
    let filled = 0;
    for (const fileName of fileNames) {
      const path = join(outDir, fileName);
      const source = readIfPresent(path);
      const next =
        source === undefined
          ? undefined
          : fillRouterVersions(source.toString("utf-8"), table);
      if (next === undefined) continue;
      writeFileSync(path, next);
      filled++;
    }
    if (environment === "rsc" && fileNames.length > 0 && filled === 0) {
      throw new Error(
        `[rango] Could not write the cache versions into the server build: no placeholder in ${fileNames.join(", ")} under ${outDir}. ` +
          `The build would fail to start. This is a bug in @rangojs/router; please report it.`,
      );
    }
  }
  s.routerVersions = table;

  const elapsed = (performance.now() - start).toFixed(1);
  const sourceOf = new Map(
    s.perRouterManifests.map((entry) => [
      entry.id,
      entry.sourceFile ? portableModuleId(entry.sourceFile, s.projectRoot) : "",
    ]),
  );
  const detailOf = new Map(details.map((detail) => [detail.routerId, detail]));
  const wholeBuild = detailOf.get(DEFAULT_ROUTER_VERSIONS_KEY)!;
  let keyed = 0;
  if (s.perRouterManifests.length > 0) {
    console.log(
      `[rango] Cache versions for ${s.perRouterManifests.length} router(s), data / document (${elapsed}ms):`,
    );
    for (const { id } of s.perRouterManifests) {
      // A router whose module is not in the server bundle serves with the
      // whole-build pair: any change clears it. Say so, it is not isolated.
      const own = detailOf.get(id);
      const detail = own ?? wholeBuild;
      if (detail.usesEncryptionKey) keyed++;
      console.log(
        `[rango]   ${detail.data} / ${detail.document}  ${sourceOf.get(id) || id}${own ? "" : " (whole build)"}`,
      );
    }
  }
  debug?.(
    "router versions: %d server file(s), %sms, table=%o",
    server.chunks.length + server.assets.length,
    elapsed,
    table,
  );
  writeVersionsReport(s.projectRoot, details, sourceOf);

  if (notFound.size > 0) {
    console.log(
      `[rango] ${notFound.size} package(s) the server build leaves external are not installed where the build ` +
        `can find them (${[...notFound].sort().join(", ")}). What they resolve to at run time is unknown, so the ` +
        `routers importing them get a new cache version on every build.`,
    );
  }

  // The one condition under which a deploy of unchanged code still clears a
  // cache: the key is part of these routers' versions and this build made its
  // own. Said once per build, and only when it applies.
  if (keyed > 0 && !isEncryptionKeyStable()) {
    console.log(
      `[rango] No stable encryption key: ${keyed} router(s) encrypt server-action arguments ` +
        `with a key generated for this build, so their cache version changes on every build and each ` +
        `deploy clears their cache. To keep it, set rango({ encryptionKey: process.env.RANGO_ENCRYPTION_KEY }) ` +
        `with a base64 32-byte key (openssl rand -base64 32).`,
    );
  }
}
