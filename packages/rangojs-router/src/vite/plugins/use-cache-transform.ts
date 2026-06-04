/**
 * "use cache" Vite Transform Plugin
 *
 * Detects "use cache" directives at file-level and function-level,
 * then wraps exports with registerCachedFunction() from the cache runtime.
 *
 * File-level: "use cache" at top of file wraps all exports (except
 * layout/template default exports which receive children).
 *
 * Function-level: "use cache: profileName" inside a function body
 * hoists the function and wraps it.
 *
 * Uses transform helpers from @vitejs/plugin-rsc/transforms:
 * - hasDirective() for file-level detection
 * - transformWrapExport() for file-level wrapping
 * - transformHoistInlineDirective() for function-level hoisting
 */

import type { Plugin } from "vite";
import path from "node:path";
import MagicString from "magic-string";
import { normalizePath, hashId } from "./expose-id-utils.js";
import { createRangoDebugger, createCounter, NS } from "../debug.js";

const debug = createRangoDebugger(NS.transform);

const CACHE_RUNTIME_IMPORT = "@rangojs/router/cache-runtime";

// Files whose default export receives {children} from the framework
// and should not be wrapped (children can't be cache-keyed).
const LAYOUT_TEMPLATE_PATTERN = /\/(layout|template)\.(tsx?|jsx?)$/;

/**
 * Grammar for a valid function-level directive: `use cache` optionally followed
 * by `: <profile-name>`. The single source of truth for both the transform and
 * the near-miss validator below.
 */
export const USE_CACHE_DIRECTIVE_RE: RegExp = /^use cache(:\s*[\w-]+)?$/;

export function useCacheTransform(): Plugin {
  let projectRoot = "";
  let isBuild = false;
  let rscTransforms: typeof import("@vitejs/plugin-rsc/transforms") | null =
    null;
  const counter = createCounter(debug, "use-cache");

  return {
    name: "@rangojs/router:use-cache",
    enforce: "post",

    configResolved(config) {
      projectRoot = config.root;
      isBuild = config.command === "build";
    },

    buildEnd() {
      counter?.flush();
    },

    async transform(code, id) {
      // Only process in RSC environment
      if (this.environment?.name !== "rsc") return;

      // Quick bail: no "use cache" in source
      if (!code.includes("use cache")) return;

      // Skip node_modules and virtual modules
      if (id.includes("/node_modules/") || id.startsWith("\0")) return;

      // Only JS/TS files
      if (!/\.(tsx?|jsx?|mjs)$/.test(id)) return;

      const start = counter ? performance.now() : 0;
      try {
        // Lazy-load transform helpers
        if (!rscTransforms) {
          try {
            rscTransforms = await import("@vitejs/plugin-rsc/transforms");
          } catch {
            return;
          }
        }

        const {
          hasDirective,
          transformWrapExport,
          transformHoistInlineDirective,
        } = rscTransforms;

        // Parse AST
        let ast: any;
        try {
          const { parseAst } = await import("vite");
          ast = parseAst(code, { lang: "tsx" });
        } catch {
          return;
        }

        const filePath = normalizePath(path.relative(projectRoot, id));
        const isLayoutOrTemplate = LAYOUT_TEMPLATE_PATTERN.test(id);

        // Check for file-level "use cache"
        if (hasDirective(ast.body, "use cache")) {
          return transformFileLevelUseCache(
            code,
            ast,
            filePath,
            id,
            isBuild,
            isLayoutOrTemplate,
            transformWrapExport,
          );
        }

        // Check for function-level "use cache" / "use cache: profileName"
        // (only if there's no file-level directive but code still contains the string)
        const functionResult = transformFunctionLevelUseCache(
          code,
          ast,
          filePath,
          id,
          isBuild,
          transformHoistInlineDirective,
        );

        // Check for near-miss directives on the function-level path. The
        // file-level branch above returns earlier (it wraps every export
        // regardless), so this runs only when there is no file-level directive.
        warnOnNearMissDirectives(ast, id, this.warn.bind(this));

        if (functionResult) return functionResult;
      } finally {
        counter?.record(id, performance.now() - start);
      }
    },
  };
}

function transformFileLevelUseCache(
  code: string,
  ast: any,
  filePath: string,
  sourceId: string,
  isBuild: boolean,
  isLayoutOrTemplate: boolean,
  transformWrapExport: (typeof import("@vitejs/plugin-rsc/transforms"))["transformWrapExport"],
) {
  // Collect non-function exports to report after wrapping
  const nonFunctionExports: string[] = [];

  const { exportNames, output } = transformWrapExport(code, ast, {
    runtime: (value: string, name: string) => {
      const funcId = isBuild ? hashId(filePath, name) : `${filePath}#${name}`;
      return `__rango_registerCachedFunction(${value}, ${JSON.stringify(funcId)}, "default")`;
    },
    rejectNonAsyncFunction: false,
    filter: (name: string, meta: { isFunction?: boolean }) => {
      // Skip default export of layout/template files (they receive children)
      if (name === "default" && isLayoutOrTemplate) return false;
      // Non-function exports cannot be wrapped with registerCachedFunction
      if (meta.isFunction === false) {
        nonFunctionExports.push(name);
        return false;
      }
      return true;
    },
  });

  if (nonFunctionExports.length > 0) {
    throw new Error(
      `[rango:use-cache] File-level "use cache" in ${sourceId} cannot wrap ` +
        `non-function export${nonFunctionExports.length > 1 ? "s" : ""}: ` +
        `${nonFunctionExports.map((n) => `"${n}"`).join(", ")}. ` +
        `Only function exports can be cached. Either remove "use cache" from ` +
        `the file level and add it inside individual functions, or move the ` +
        `non-function exports to a separate module.`,
    );
  }

  if (exportNames.length === 0) {
    // Even if no exports were wrapped, strip the directive
    const s = new MagicString(code);
    const directive = findFileLevelDirective(ast);
    if (directive) {
      s.overwrite(
        directive.start,
        directive.end,
        `/* "use cache" -- wrapped by rango */`,
      );
      return {
        code: s.toString(),
        map: s.generateMap({ source: sourceId, hires: "boundary" }),
      };
    }
    return;
  }

  // Prepend the import
  output.prepend(
    `import { registerCachedFunction as __rango_registerCachedFunction } from ${JSON.stringify(CACHE_RUNTIME_IMPORT)};\n`,
  );

  // Replace the directive with a comment
  const directive = findFileLevelDirective(ast);
  if (directive) {
    output.overwrite(
      directive.start,
      directive.end,
      `/* "use cache" -- wrapped by rango */`,
    );
  }

  return {
    code: output.toString(),
    map: output.generateMap({ source: sourceId, hires: "boundary" }),
  };
}

function transformFunctionLevelUseCache(
  code: string,
  ast: any,
  filePath: string,
  sourceId: string,
  isBuild: boolean,
  transformHoistInlineDirective: (typeof import("@vitejs/plugin-rsc/transforms"))["transformHoistInlineDirective"],
) {
  try {
    const { output, names } = transformHoistInlineDirective(code, ast, {
      directive: USE_CACHE_DIRECTIVE_RE,
      runtime: (
        value: string,
        name: string,
        meta: { directiveMatch: RegExpMatchArray },
      ) => {
        const funcId = isBuild ? hashId(filePath, name) : `${filePath}#${name}`;
        const profileMatch = meta.directiveMatch[1];
        const profileName = profileMatch
          ? profileMatch.replace(/^:\s*/, "").trim()
          : "default";
        return `__rango_registerCachedFunction(${value}, ${JSON.stringify(funcId)}, ${JSON.stringify(profileName)})`;
      },
      rejectNonAsyncFunction: false,
    });

    if (names.length === 0) return;

    // Use a top-level import instead of await import() — the hoisted wrapper
    // may be placed in a non-async context (e.g., inside a synchronous
    // urls() callback) where await is not allowed.
    output.prepend(
      `import { registerCachedFunction as __rango_registerCachedFunction } from ${JSON.stringify(CACHE_RUNTIME_IMPORT)};\n`,
    );

    return {
      code: output.toString(),
      map: output.generateMap({ source: sourceId, hires: "boundary" }),
    };
  } catch {
    // Transform failed (e.g., syntax not supported), skip
    return;
  }
}

/**
 * Find the file-level "use cache" directive AST node for removal.
 */
function findFileLevelDirective(
  ast: any,
): { start: number; end: number } | null {
  for (const node of ast.body ?? []) {
    if (
      node.type === "ExpressionStatement" &&
      node.expression?.type === "Literal" &&
      typeof node.expression.value === "string" &&
      node.expression.value.startsWith("use cache")
    ) {
      return { start: node.start, end: node.end };
    }
  }
  return null;
}

/**
 * Regex for near-miss: starts with "use cache:" but has invalid tokens.
 */
const NEAR_MISS_RE = /^use cache:\s*.+$/;

/**
 * Walk the AST looking for string literals that look like malformed
 * "use cache" directives and emit a Vite warning for each.
 *
 * This catches cases like `"use cache: bad.name"` or `"use cache: "`
 * that the transform regex silently ignores.
 */
function warnOnNearMissDirectives(
  ast: any,
  fileId: string,
  warn: (message: string) => void,
): void {
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;

    if (
      node.type === "ExpressionStatement" &&
      node.expression?.type === "Literal" &&
      typeof node.expression.value === "string"
    ) {
      const value = node.expression.value;
      if (
        value.startsWith("use cache") &&
        NEAR_MISS_RE.test(value) &&
        !USE_CACHE_DIRECTIVE_RE.test(value)
      ) {
        const profilePart = value.slice("use cache:".length).trim();
        warn(
          `[rango:use-cache] "${value}" in ${fileId} has an invalid profile name "${profilePart}". ` +
            `Profile names must match [a-zA-Z0-9_-]+. This directive will be ignored.`,
        );
      }
    }

    // Walk into function bodies where directives appear
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          visit(item);
        }
      } else if (child && typeof child === "object" && child.type) {
        visit(child);
      }
    }
  };

  for (const node of ast.body ?? []) {
    visit(node);
  }
}
