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

        let ast: any;
        try {
          const { parseAst } = await import("vite");
          ast = parseAst(code, { lang: "tsx" });
        } catch {
          return;
        }

        const filePath = normalizePath(path.relative(projectRoot, id));
        const isLayoutOrTemplate = LAYOUT_TEMPLATE_PATTERN.test(id);

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

        const functionResult = transformFunctionLevelUseCache(
          code,
          ast,
          filePath,
          id,
          isBuild,
          transformHoistInlineDirective,
        );

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
  const unconfirmedExports: string[] = [];

  const { exportNames, output } = transformWrapExport(code, ast, {
    runtime: (value: string, name: string) => {
      const funcId = isBuild ? hashId(filePath, name) : `${filePath}#${name}`;
      return `__rango_registerCachedFunction(${value}, ${JSON.stringify(funcId)}, "default")`;
    },
    rejectNonAsyncFunction: false,
    filter: (name: string, meta: { isFunction?: boolean }) => {
      if (name === "default" && isLayoutOrTemplate) return false;
      // isFunction is boolean | undefined: true = confirmed function, false =
      // confirmed non-function, undefined = cannot tell statically (e.g. a
      // factory/HOF initializer `const x = makeCached(fn)`). Deliberate policy:
      // require a confirmed function and reject everything else, including
      // indeterminate initializers that may be functions at runtime -- rewrite
      // those as direct async functions. (Pre-#1246 plugin-rsc reported false,
      // not undefined, here, so === false would wrongly wrap them post-bump.)
      if (meta.isFunction !== true) {
        unconfirmedExports.push(name);
        return false;
      }
      return true;
    },
  });

  if (unconfirmedExports.length > 0) {
    const plural = unconfirmedExports.length > 1;
    throw new Error(
      `[rango:use-cache] File-level "use cache" in ${sourceId} only wraps ` +
        `exports that are statically-confirmed functions. ` +
        `${plural ? "These exports are" : "This export is"} not: ` +
        `${unconfirmedExports.map((n) => `"${n}"`).join(", ")}. ` +
        `Declare them directly (export async function foo() {} or ` +
        `export const foo = async () => {}). A factory or otherwise ` +
        `statically-indeterminate initializer (export const foo = makeCached(fn)) ` +
        `is rejected even if it returns a function at runtime -- rewrite it as a ` +
        `direct async function, or move non-function exports to a separate module.`,
    );
  }

  if (exportNames.length === 0) {
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

  output.prepend(
    `import { registerCachedFunction as __rango_registerCachedFunction } from ${JSON.stringify(CACHE_RUNTIME_IMPORT)};\n`,
  );

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

const NEAR_MISS_RE = /^use cache:\s*.+$/;

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
