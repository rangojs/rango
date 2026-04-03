import type { Plugin, ResolvedConfig } from "vite";
import { parseAst } from "vite";
import MagicString from "magic-string";
import path from "node:path";
import {
  normalizePath,
  hashId,
  makeStubId,
  detectImports,
} from "./expose-id-utils.js";
import {
  transformInlineHandlers,
  type VirtualHandlerEntry,
} from "../utils/ast-handler-extract.js";

import type {
  HandlerTransformConfig,
  CreateExportBinding,
} from "./expose-ids/types.js";
import {
  PRERENDER_CONFIG,
  STATIC_CONFIG,
  STRICT_CREATE_CONFIGS,
  type ExposeInternalIdsApi,
} from "./expose-ids/types.js";
import {
  countCreateCallsForNames,
  getImportedFnNames,
  collectCreateExportBindings,
  buildUnsupportedShapeWarning,
  isExportOnlyFile,
} from "./expose-ids/export-analysis.js";
import {
  hasCreateLoaderImport,
  generateClientLoaderStubs,
  transformLoaders,
} from "./expose-ids/loader-transform.js";
import {
  transformHandles,
  transformLocationState,
  generateWholeFileStubs,
  generateExprStubs,
  stubHandlerExprs,
  transformHandlerIds,
} from "./expose-ids/handler-transform.js";

// Re-exports consumed by other packages/plugins
export { exposeRouterId } from "./expose-ids/router-transform.js";
export type { ExposeInternalIdsApi } from "./expose-ids/types.js";

// ---------------------------------------------------------------------------
// Virtual module for loader manifest
// ---------------------------------------------------------------------------

const VIRTUAL_LOADER_MANIFEST = "virtual:rsc-router/loader-manifest";
const RESOLVED_VIRTUAL_LOADER_MANIFEST = "\0" + VIRTUAL_LOADER_MANIFEST;

// ---------------------------------------------------------------------------
// Virtual module prefix for extracted inline handlers
// ---------------------------------------------------------------------------

const VIRTUAL_HANDLER_PREFIX = "virtual:handler-extract:";

// ---------------------------------------------------------------------------
// Consolidated plugin
// ---------------------------------------------------------------------------

export function exposeInternalIds(options?: { forceBuild?: boolean }): Plugin {
  let config: ResolvedConfig;
  let isBuild = false;
  let projectRoot = "";

  // Loader registry: hashedId -> { filePath, exportName }
  const loaderRegistry = new Map<
    string,
    { filePath: string; exportName: string }
  >();

  // Prerender handler module tracking (consumed via plugin API)
  const prerenderHandlerModules: Map<string, string[]> = new Map();

  // Static handler module tracking (consumed via plugin API)
  const staticHandlerModules: Map<string, string[]> = new Map();

  // Virtual module registry for inline handler extraction (both types)
  const virtualHandlers = new Map<string, VirtualHandlerEntry>();
  // De-duplicate unsupported shape warnings across repeated transforms.
  const unsupportedShapeWarnings = new Set<string>();

  return {
    name: "@rangojs/router:expose-internal-ids",
    enforce: "post",

    api: {
      prerenderHandlerModules,
      staticHandlerModules,
    } satisfies ExposeInternalIdsApi,

    configResolved(resolved) {
      config = resolved;
      isBuild = options?.forceBuild || config.command === "build";
      projectRoot = config.root;
    },

    // --------------- Virtual module support ---------------

    resolveId(id, importer) {
      if (id === VIRTUAL_LOADER_MANIFEST) {
        return RESOLVED_VIRTUAL_LOADER_MANIFEST;
      }
      if (id.startsWith(VIRTUAL_HANDLER_PREFIX)) {
        return "\0" + id;
      }
      // Resolve imports FROM virtual modules against the original file
      if (importer?.startsWith("\0" + VIRTUAL_HANDLER_PREFIX)) {
        const entry = virtualHandlers.get(importer);
        if (entry) {
          return this.resolve(id, entry.originalModuleId, { skipSelf: true });
        }
      }
    },

    load(id) {
      // Virtual handler modules (both prerender and static)
      if (id.startsWith("\0" + VIRTUAL_HANDLER_PREFIX)) {
        const entry = virtualHandlers.get(id);
        if (!entry) return null;
        return (
          [
            ...entry.imports,
            ...entry.declarations,
            `export const ${entry.exportName} = ${entry.handlerCode};`,
          ].join("\n") + "\n"
        );
      }

      if (id !== RESOLVED_VIRTUAL_LOADER_MANIFEST) return;

      if (!isBuild) {
        return `import { setLoaderImports } from "@rangojs/router/server";

// Dev mode: empty map, loaders are resolved dynamically via path parsing
setLoaderImports({});
`;
      }

      // Build mode: generate lazy import map
      const lazyImports: string[] = [];

      for (const [hashedId, { filePath, exportName }] of loaderRegistry) {
        lazyImports.push(
          `  "${hashedId}": () => import("/${filePath}").then(m => m.${exportName})`,
        );
      }

      if (lazyImports.length === 0) {
        return `import { setLoaderImports } from "@rangojs/router/server";

// No fetchable loaders discovered during build
setLoaderImports({});
`;
      }

      return `import { setLoaderImports } from "@rangojs/router/server";

// Lazy import map - loaders are loaded on-demand when first requested
setLoaderImports({
${lazyImports.join(",\n")}
});
`;
    },

    // --------------- Loader pre-scan (build mode) ---------------

    async buildStart() {
      if (!isBuild) return;

      const fs = await import("node:fs/promises");

      const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage"]);

      async function scanDir(dir: string): Promise<string[]> {
        const results: string[] = [];
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
                results.push(...(await scanDir(fullPath)));
              }
            } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
              results.push(fullPath);
            }
          }
        } catch {
          // Directory doesn't exist or not readable
        }
        return results;
      }

      try {
        const files = await scanDir(projectRoot);

        for (const filePath of files) {
          const content = await fs.readFile(filePath, "utf-8");

          if (!content.includes("createLoader")) continue;
          if (!hasCreateLoaderImport(content)) continue;

          const fnNames = getImportedFnNames(content, "createLoader");
          const relativePath = normalizePath(
            path.relative(projectRoot, filePath),
          );
          const bindings = collectCreateExportBindings(content, fnNames);

          for (const binding of bindings) {
            const exportName = binding.exportNames[0];
            const hashedId = hashId(relativePath, exportName);
            loaderRegistry.set(hashedId, {
              filePath: relativePath,
              exportName,
            });
          }
        }
      } catch (error) {
        console.warn("[exposeInternalIds] Loader pre-scan failed:", error);
      }
    },

    // --------------- Unified transform ---------------

    transform(code, id) {
      if (id.includes("/node_modules/")) return;

      const filePath = normalizePath(path.relative(projectRoot, id));
      const isRscEnv = this.environment?.name === "rsc";

      // Warn if named-routes.gen is imported in a client component.
      // NamedRoutes is server-only data and would bloat the client bundle.
      if (
        id.includes(".named-routes.gen.") &&
        !isRscEnv &&
        this.environment?.name === "client"
      ) {
        this.warn(
          `\n` +
            `!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n` +
            `!!                                                              !!\n` +
            `!!  WARNING: NamedRoutes imported in a CLIENT component!        !!\n` +
            `!!                                                              !!\n` +
            `!!  File: ${filePath.padEnd(53)}!!\n` +
            `!!                                                              !!\n` +
            `!!  NamedRoutes contains your entire route structure — every    !!\n` +
            `!!  route name and URL pattern in your application. Shipping    !!\n` +
            `!!  this to the browser exposes your full routing topology to   !!\n` +
            `!!  the client, which is a security concern (internal/admin     !!\n` +
            `!!  routes, API endpoints, hidden paths become visible).        !!\n` +
            `!!                                                              !!\n` +
            `!!  It also bloats the client bundle — this map contains all    !!\n` +
            `!!  named routes in your application.                           !!\n` +
            `!!                                                              !!\n` +
            `!!  Fix: remove the import or move it to a server component.    !!\n` +
            `!!                                                              !!\n` +
            `!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n`,
        );
      }

      // Fast exit: if the file doesn't import from @rangojs/router at all,
      // skip all create* analysis and transforms.
      if (!code.includes("@rangojs/router")) return;

      // Detect all relevant imports in one pass
      const has = detectImports(code);

      // Quick bail-out: also check for raw create* identifiers.
      // This is safe even with aliases (e.g., `import { createLoader as cl }`)
      // because the import statement itself always contains the canonical name
      // "createLoader", so code.includes("createLoader") will still match.
      const hasLoaderCode = has.loader && code.includes("createLoader");
      const hasHandleCode = has.handle && code.includes("createHandle");
      const hasLocationStateCode =
        has.locationState && code.includes("createLocationState");
      const hasPrerenderHandlerCode =
        has.prerenderHandler && code.includes("Prerender");
      const hasStaticHandlerCode = has.staticHandler && code.includes("Static");
      if (
        !hasLoaderCode &&
        !hasHandleCode &&
        !hasLocationStateCode &&
        !hasPrerenderHandlerCode &&
        !hasStaticHandlerCode
      ) {
        return;
      }

      // Per-invocation caches to avoid redundant AST parsing.
      // getImportedFnNames is cached by canonical name (imports never change).
      // collectCreateExportBindings is cached by fnNames key; the cache is
      // cleared when `code` changes (e.g., after inline handler extraction).
      const _fnNamesCache = new Map<string, string[]>();
      const _bindingsCache = new Map<string, CreateExportBinding[]>();
      let _cachedAst: any;
      let _astParseFailed = false;
      let _astCodeRef = code;

      const getFnNames = (canonicalName: string): string[] => {
        let result = _fnNamesCache.get(canonicalName);
        if (!result) {
          result = getImportedFnNames(code, canonicalName);
          _fnNamesCache.set(canonicalName, result);
        }
        return result;
      };

      // Lazy AST parse: parsed once and shared across all
      // collectCreateExportBindings calls for the same code string.
      const lazyAst = (): any | undefined => {
        if (code !== _astCodeRef) {
          _cachedAst = undefined;
          _astParseFailed = false;
          _astCodeRef = code;
        }
        if (_cachedAst !== undefined || _astParseFailed) return _cachedAst;
        try {
          _cachedAst = parseAst(code, { jsx: true });
        } catch {
          _astParseFailed = true;
        }
        return _cachedAst;
      };

      const getBindings = (
        currentCode: string,
        fnNames: string[],
      ): CreateExportBinding[] => {
        const key = fnNames.join("\0");
        let result = _bindingsCache.get(key);
        if (!result) {
          result = collectCreateExportBindings(currentCode, fnNames, lazyAst());
          _bindingsCache.set(key, result);
        }
        return result;
      };

      // Warn on create* declaration shapes that are currently unsupported by
      // non-AST transforms (loader/handle/locationState only).
      for (const cfg of STRICT_CREATE_CONFIGS) {
        const hasCode =
          cfg.fnName === "createLoader"
            ? hasLoaderCode
            : cfg.fnName === "createHandle"
              ? hasHandleCode
              : hasLocationStateCode;
        if (!hasCode) continue;

        const fnNames = getFnNames(cfg.fnName);
        const totalCalls = countCreateCallsForNames(code, fnNames);
        const supportedBindings = getBindings(code, fnNames).length;
        if (totalCalls <= supportedBindings) continue;

        const warnKey = `${id}::${cfg.fnName}`;
        if (unsupportedShapeWarnings.has(warnKey)) continue;
        unsupportedShapeWarnings.add(warnKey);
        this.warn(buildUnsupportedShapeWarning(filePath, cfg.fnName));
      }

      // --- Loader: track for manifest (RSC env only) ---
      if (hasLoaderCode && isRscEnv) {
        const fnNames = getFnNames("createLoader");
        const bindings = getBindings(code, fnNames);
        for (const binding of bindings) {
          const exportName = binding.exportNames[0];
          const hashedId = hashId(filePath, exportName);
          loaderRegistry.set(hashedId, {
            filePath,
            exportName,
          });
        }
      }

      // --- Loader: client stubs for non-RSC environments ---
      if (hasLoaderCode && !isRscEnv) {
        const fnNames = getFnNames("createLoader");
        const bindings = getBindings(code, fnNames);
        const stubResult = generateClientLoaderStubs(
          bindings,
          code,
          filePath,
          isBuild,
        );
        if (stubResult) return stubResult;
      }

      // --- PrerenderHandler: non-RSC whole-file stub replacement ---
      // When ALL exports are Prerender() calls, replace the entire file.
      // Mixed-export files are handled in the unified pipeline below.
      if (hasPrerenderHandlerCode && !isRscEnv) {
        const fnNames = getFnNames(PRERENDER_CONFIG.fnName);
        const bindings = getBindings(code, fnNames);
        const wholeFile = generateWholeFileStubs(
          PRERENDER_CONFIG,
          bindings,
          code,
          filePath,
          isBuild,
        );
        if (wholeFile) return wholeFile;
      }

      // --- PrerenderHandler: RSC build module tracking ---
      if (hasPrerenderHandlerCode && isRscEnv && isBuild) {
        const fnNames = getFnNames(PRERENDER_CONFIG.fnName);
        const exportNames = getBindings(code, fnNames).map(
          (b) => b.exportNames[0],
        );
        if (exportNames.length > 0) {
          prerenderHandlerModules.set(id, exportNames);
        }
      }

      // --- Inline handler extraction to virtual modules ---
      // Runs before stubs/tracking so inline calls become imports, then
      // the existing regex fast path handles both the original file's
      // export const patterns and the virtual modules independently.
      //
      // Cheap pre-check: count total fnName( occurrences vs export const
      // patterns. If they match, every call is a named export and the
      // regex fast path handles them -- skip the AST parse entirely.
      //
      // Each iteration creates a fresh MagicString so that AST positions
      // from findHandlerCalls always match the string they were parsed from.
      let changed = false;

      const handlerConfigs = [
        hasStaticHandlerCode && STATIC_CONFIG,
        hasPrerenderHandlerCode && PRERENDER_CONFIG,
      ]
        .filter((c): c is HandlerTransformConfig => !!c)
        .map((cfg) => {
          const fnNames = getFnNames(cfg.fnName);
          return { cfg, fnNames };
        });

      for (const { cfg, fnNames } of handlerConfigs) {
        const totalCalls = countCreateCallsForNames(code, fnNames);
        const supportedBindings = getBindings(code, fnNames).length;

        if (totalCalls > supportedBindings) {
          const iterS = new MagicString(code);
          const result = transformInlineHandlers(
            cfg.fnName,
            VIRTUAL_HANDLER_PREFIX,
            iterS,
            code,
            filePath,
            virtualHandlers,
            id,
            parseAst,
          );
          if (result) {
            changed = true;
            code = iterS.toString();
            _bindingsCache.clear();
          }
        }
      }

      // --- StaticHandler: non-RSC whole-file stub replacement ---
      // When ALL exports are Static() calls, replace the entire file.
      if (hasStaticHandlerCode && !isRscEnv) {
        const fnNames = getFnNames(STATIC_CONFIG.fnName);
        const bindings = getBindings(code, fnNames);
        const wholeFile = generateWholeFileStubs(
          STATIC_CONFIG,
          bindings,
          code,
          filePath,
          isBuild,
        );
        if (wholeFile) return wholeFile;
      }

      // --- Mixed-type whole-file stub replacement (non-RSC) ---
      // When the individual whole-file checks above fail (each only checks
      // one type), the file has mixed exports (e.g. createLoader + Prerender).
      // Gather ALL stub-safe bindings and check if they cover every export.
      // If yes, replace the entire file with stubs — this strips server-only
      // imports (node:fs, DB clients, etc.) that would crash in the browser.
      //
      // Only applies when the file contains Prerender/Static (the handler
      // types that bring server-only code). Files with only loaders, handles,
      // or locationState are handled correctly by the unified pipeline below.
      //
      // Loader, Prerender, and Static exports become plain { __brand, $$id }
      // stubs. createHandle and createLocationState need their create*()
      // functions to execute (collect registration / __rsc_ls_key), so their
      // call expressions are preserved with only a @rangojs/router import.
      // This strips all server-only imports while keeping the correct
      // client contract for every export type.
      if (!isRscEnv && (hasPrerenderHandlerCode || hasStaticHandlerCode)) {
        const prerenderFnNames = hasPrerenderHandlerCode
          ? getFnNames(PRERENDER_CONFIG.fnName)
          : [];
        const staticFnNames = hasStaticHandlerCode
          ? getFnNames(STATIC_CONFIG.fnName)
          : [];
        const loaderFnNames = hasLoaderCode ? getFnNames("createLoader") : [];
        const handleFnNames = hasHandleCode ? getFnNames("createHandle") : [];
        const lsFnNames = hasLocationStateCode
          ? getFnNames("createLocationState")
          : [];

        // Collect ALL recognized bindings to check export coverage
        const allBindings: CreateExportBinding[] = [];
        for (const fnNames of [
          prerenderFnNames,
          staticFnNames,
          loaderFnNames,
          handleFnNames,
          lsFnNames,
        ]) {
          if (fnNames.length > 0) {
            allBindings.push(...getBindings(code, fnNames));
          }
        }

        // Check if preserved createHandle/createLocationState calls
        // reference non-exported locals (e.g. helper functions, constants).
        // If so, the whole-file stub would strip those locals, breaking
        // the call. Fall through to the unified pipeline instead.
        let canStubWholeFile =
          allBindings.length > 0 && isExportOnlyFile(code, allBindings);

        if (
          canStubWholeFile &&
          (handleFnNames.length > 0 || lsFnNames.length > 0)
        ) {
          const exportedLocals = new Set(allBindings.map((b) => b.localName));
          // Collect bindings that would be stripped by whole-file replacement:
          // local declarations and imported bindings from non-@rangojs/router
          // modules. This is a regex-based heuristic — it intentionally skips
          // edge cases (class decls, destructured bindings, combined
          // default+named imports) since those rarely appear in route files.
          const strippedBindings: string[] = [];

          const localDeclPattern =
            /(?:^|;|\n)\s*(?:const|let|var|function)\s+(\w+)/g;
          let declMatch: RegExpExecArray | null;
          while ((declMatch = localDeclPattern.exec(code)) !== null) {
            if (!exportedLocals.has(declMatch[1])) {
              strippedBindings.push(declMatch[1]);
            }
          }

          const importPattern =
            /import\s*\{([^}]*)\}\s*from\s*["'](?!@rangojs\/router)[^"']*["']/g;
          let importMatch: RegExpExecArray | null;
          while ((importMatch = importPattern.exec(code)) !== null) {
            for (const spec of importMatch[1].split(",")) {
              const m = spec
                .trim()
                .match(/^[A-Za-z_$][\w$]*(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
              if (m) strippedBindings.push(m[1] || m[0].trim().split(/\s/)[0]);
            }
          }
          const defaultImportPattern =
            /import\s+([A-Za-z_$][\w$]*)\s+from\s*["'](?!@rangojs\/router)[^"']*["']/g;
          while ((importMatch = defaultImportPattern.exec(code)) !== null) {
            strippedBindings.push(importMatch[1]);
          }
          const nsImportPattern =
            /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*["'](?!@rangojs\/router)[^"']*["']/g;
          while ((importMatch = nsImportPattern.exec(code)) !== null) {
            strippedBindings.push(importMatch[1]);
          }

          if (strippedBindings.length > 0) {
            const preservedBindings = allBindings.filter((b) => {
              const fc = code.slice(b.callExprStart, b.callOpenParenPos + 1);
              return (
                handleFnNames.some((n) => fc.includes(n)) ||
                lsFnNames.some((n) => fc.includes(n))
              );
            });
            const strippedRe = new RegExp(
              `\\b(?:${strippedBindings.join("|")})\\b`,
            );
            canStubWholeFile = !preservedBindings.some((b) => {
              const expr = code.slice(b.callExprStart, b.callCloseParenPos + 1);
              return strippedRe.test(expr);
            });
          }
        }

        if (canStubWholeFile) {
          const lines: string[] = [];
          const neededImports: string[] = [];
          if (handleFnNames.length > 0) neededImports.push("createHandle");
          if (lsFnNames.length > 0) neededImports.push("createLocationState");
          if (neededImports.length > 0) {
            lines.push(
              `import { ${neededImports.join(", ")} } from "@rangojs/router";`,
            );
          }

          for (const binding of allBindings) {
            const fnCall = code.slice(
              binding.callExprStart,
              binding.callOpenParenPos + 1,
            );
            const isHandle = handleFnNames.some((n) => fnCall.includes(n));
            const isLocationState = lsFnNames.some((n) => fnCall.includes(n));

            // Aliases share the primary name's ID (matches server transforms).
            const primaryName = binding.exportNames[0];
            const stubId = makeStubId(filePath, primaryName, isBuild);

            if (isHandle || isLocationState) {
              // Rewrite alias to canonical name since the stub file only
              // imports canonical names from @rangojs/router.
              const rawCallExpr = code.slice(
                binding.callExprStart,
                binding.callCloseParenPos + 1,
              );
              const canonicalName = isHandle
                ? "createHandle"
                : "createLocationState";
              const activeFnNames = isHandle ? handleFnNames : lsFnNames;
              let callExpr = rawCallExpr;
              for (const alias of activeFnNames) {
                if (alias !== canonicalName && callExpr.startsWith(alias)) {
                  callExpr = canonicalName + callExpr.slice(alias.length);
                  break;
                }
              }
              lines.push(`export const ${primaryName} = ${callExpr};`);
              if (isHandle) {
                lines.push(`${primaryName}.$$id = "${stubId}";`);
              } else {
                lines.push(
                  `${primaryName}.__rsc_ls_key = "__rsc_ls_${stubId}";`,
                );
              }
              for (const name of binding.exportNames.slice(1)) {
                lines.push(`export const ${name} = ${primaryName};`);
              }
            } else {
              let brand = "loader";
              if (prerenderFnNames.some((n) => fnCall.includes(n))) {
                brand = PRERENDER_CONFIG.brand;
              } else if (staticFnNames.some((n) => fnCall.includes(n))) {
                brand = STATIC_CONFIG.brand;
              }
              lines.push(
                `export const ${primaryName} = { __brand: "${brand}", $$id: "${stubId}" };`,
              );
              for (const name of binding.exportNames.slice(1)) {
                lines.push(`export const ${name} = ${primaryName};`);
              }
            }
          }

          return { code: lines.join("\n") + "\n", map: null };
        }
      }

      // --- StaticHandler: RSC build module tracking ---
      if (hasStaticHandlerCode && isRscEnv && isBuild) {
        const fnNames = getFnNames(STATIC_CONFIG.fnName);
        const exportNames = getBindings(code, fnNames).map(
          (b) => b.exportNames[0],
        );
        if (exportNames.length > 0) {
          staticHandlerModules.set(id, exportNames);
        }
      }

      // --- Unified MagicString transforms ---
      // Single pipeline for all downstream transforms (loaders, handles,
      // locationState, handler IDs). Uses the post-extraction code so
      // positions are always consistent.
      const s = new MagicString(code);

      if (hasLoaderCode) {
        const fnNames = getFnNames("createLoader");
        changed =
          transformLoaders(getBindings(code, fnNames), s, filePath, isBuild) ||
          changed;
      }
      if (hasHandleCode) {
        const fnNames = getFnNames("createHandle");
        changed =
          transformHandles(
            getBindings(code, fnNames),
            s,
            code,
            filePath,
            isBuild,
          ) || changed;
      }
      if (hasLocationStateCode) {
        const fnNames = getFnNames("createLocationState");
        changed =
          transformLocationState(
            getBindings(code, fnNames),
            s,
            filePath,
            isBuild,
          ) || changed;
      }
      if (hasPrerenderHandlerCode) {
        const fnNames = getFnNames(PRERENDER_CONFIG.fnName);
        const bindings = getBindings(code, fnNames);
        if (isRscEnv) {
          changed =
            transformHandlerIds(
              PRERENDER_CONFIG,
              bindings,
              s,
              filePath,
              isBuild,
            ) || changed;
        } else {
          // Non-RSC mixed-export file: replace Prerender() calls with stubs
          // on the shared MagicString so sourcemaps stay accurate.
          changed =
            stubHandlerExprs(
              PRERENDER_CONFIG,
              bindings,
              s,
              filePath,
              isBuild,
            ) || changed;
        }
      }
      if (hasStaticHandlerCode) {
        const fnNames = getFnNames(STATIC_CONFIG.fnName);
        const bindings = getBindings(code, fnNames);
        if (isRscEnv) {
          changed =
            transformHandlerIds(
              STATIC_CONFIG,
              bindings,
              s,
              filePath,
              isBuild,
            ) || changed;
        } else {
          changed =
            stubHandlerExprs(STATIC_CONFIG, bindings, s, filePath, isBuild) ||
            changed;
        }
      }

      if (!changed) return;

      return {
        code: s.toString(),
        map: s.generateMap({ source: id, includeContent: true }),
      };
    },
  };
}
