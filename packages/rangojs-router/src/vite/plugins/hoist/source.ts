/**
 * Source reading shared by the build-time predicate hoists
 * (transition-when-hoist.ts, client-urls-revalidate-hoist.ts): which ids are
 * source files, reading one off disk, resolving an import to the file it
 * names, and the "emitted or disk" lookup behind their `?rango-*` modules.
 */

import { readFile } from "node:fs/promises";
import { normalizePath } from "vite";

/** A file path (query already stripped) a hoist transform may rewrite. */
export const SOURCE_FILE_RE: RegExp = /\.[cm]?[jt]sx?$/;

export async function readSource(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf-8");
  } catch {
    return null;
  }
}

/** The part of a plugin context {@link resolveSourceTarget} needs. */
export interface SourceResolver {
  resolve(
    source: string,
    importer?: string,
  ): Promise<{ id: string; external?: boolean | string } | null>;
}

/**
 * The file `source` names when imported from `importer`, query stripped, or
 * null when it is external or virtual. `skipNodeModules` also yields null for
 * a dependency: transition-when-hoist only looks for `import "server-only"`
 * in project files, while client-urls-revalidate-hoist must see the
 * "use client" directive of a package's modules too.
 */
export async function resolveSourceTarget(
  ctx: SourceResolver,
  source: string,
  importer: string,
  options: { readonly skipNodeModules: boolean },
): Promise<string | null> {
  const resolved = await ctx.resolve(source, importer);
  if (!resolved || resolved.external) return null;
  const target = resolved.id.split("?", 1)[0]!;
  if (target.startsWith("\0")) return null;
  if (options.skipNodeModules && target.includes("/node_modules/")) {
    return null;
  }
  return target;
}

/** What a hoist's RSC transform emitted for a file, and the disk source it saw. */
export interface EmittedEntry<T> {
  readonly disk: string | null;
  readonly value: T;
}

export async function recordEmitted<T>(
  emitted: Map<string, EmittedEntry<T>>,
  file: string,
  value: T,
): Promise<void> {
  emitted.set(file, { disk: await readSource(file), value });
}

/**
 * What a `?rango-*` load serves for `hoistedFile`, whose source on disk is
 * `disk` (readSource): the transform's emission when it saw that source (or
 * the file is gone), else `rehoist(disk)`. The transform hoists the pipeline
 * code, which an earlier plugin may have changed, so re-hoisting the disk
 * source is the fallback only for an environment loading before the RSC
 * transform ran or for an edit the RSC environment has not re-transformed
 * yet. Undefined when neither exists.
 */
export async function loadEmittedOrDisk<T>(
  emitted: ReadonlyMap<string, EmittedEntry<T>>,
  hoistedFile: string,
  disk: string | null,
  rehoist: (disk: string) => Promise<T | undefined>,
): Promise<T | undefined> {
  const entry = emitted.get(normalizePath(hoistedFile));
  if (entry && (disk === null || entry.disk === disk)) return entry.value;
  return disk === null ? undefined : rehoist(disk);
}
