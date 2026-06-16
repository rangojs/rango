import type { Plugin } from "vite";
import MagicString from "magic-string";
import path from "node:path";
import { createHash } from "node:crypto";
import { normalizePath, findMatchingParen } from "../expose-id-utils.js";
import { getImportedFnNames } from "./export-analysis.js";
import { codeMatchIndices } from "../../../build/route-types/source-scan.js";
import { createRangoDebugger, createCounter, NS } from "../../debug.js";

const debug = createRangoDebugger(NS.transform);

export function transformRouter(
  code: string,
  filePath: string,
  routerFnNames: string[],
  absolutePath?: string,
): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  const pat = new RegExp(
    `\\b(?:${routerFnNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*(?:<[^>]*>)?\\s*\\(`,
    "g",
  );
  let match: RegExpExecArray | null;
  const s = new MagicString(code);
  let changed = false;

  // Compute the import path for the generated route names file.
  // filePath is relative to project root (e.g., "src/router.tsx")
  const basename = path.basename(filePath).replace(/\.(tsx?|jsx?)$/, "");
  const routeNamesImport = `./${basename}.named-routes.gen.js`;
  const routeNamesVar = `__rsc_rn`;

  // Only inject at call sites in REAL code, not inside comments or string
  // literals — e.g. a `createRouter({ ... })` snippet in a JSDoc example must
  // not get a `$$id`/`.named-routes.gen` import injected. The sibling analysis
  // path (export-analysis.ts) already uses this same comment/string-aware scan;
  // the raw `pat.exec(code)` loop below would otherwise match in comments too.
  const codeOffsets = new Set(codeMatchIndices(code, pat));
  pat.lastIndex = 0;

  while ((match = pat.exec(code)) !== null) {
    if (!codeOffsets.has(match.index)) continue;
    const callStart = match.index;
    const parenPos = match.index + match[0].length - 1;

    const closeParen = findMatchingParen(code, parenPos + 1);
    const callArgs = code.slice(parenPos + 1, closeParen);

    if (callArgs.includes("$$id")) continue;

    const lineNumber = code.slice(0, callStart).split("\n").length;
    const hash = createHash("sha256")
      .update(`${filePath}:${lineNumber}`)
      .digest("hex")
      .slice(0, 8);

    changed = true;
    const sourceFilePath = absolutePath ?? filePath;
    const injected = ` $$id: "${hash}", $$sourceFile: "${sourceFilePath}", $$routeNames: ${routeNamesVar},`;

    const afterParen = callArgs.trimStart();
    if (afterParen.startsWith("{")) {
      const bracePos = code.indexOf("{", parenPos + 1);
      s.appendRight(bracePos + 1, injected);
    } else if (afterParen.startsWith(")")) {
      s.appendRight(parenPos + 1, `{${injected} }`);
    }
  }

  if (!changed) return null;

  s.prepend(
    `import { NamedRoutes as ${routeNamesVar} } from "${routeNamesImport}";\n`,
  );

  return {
    code: s.toString(),
    map: s.generateMap({ hires: true }),
  };
}

/**
 * Inject stable $$id into createRouter() calls at compile time.
 * This must be a separate plugin without enforce:"post" because running
 * at "post" priority changes Vite's dep optimization timing and can cause
 * ERR_OUTDATED_OPTIMIZED_DEP / React dual-instance issues.
 */
export function exposeRouterId(): Plugin {
  let projectRoot = "";
  const counter = createCounter(debug, "expose-router-id");
  return {
    name: "@rangojs/router:expose-router-id",
    configResolved(config) {
      projectRoot = config.root;
    },
    buildEnd() {
      counter?.flush();
    },
    transform(code, id) {
      if (!code.includes("createRouter")) return null;
      if (
        !/import\s*\{[^}]*\bcreateRouter\b[^}]*\}\s*from\s*["']@rangojs\/router(?:\/server)?["']/.test(
          code,
        )
      ) {
        return null;
      }
      if (id.includes("node_modules")) return null;

      const start = counter ? performance.now() : 0;
      try {
        const filePath = normalizePath(path.relative(projectRoot, id));
        const routerFnNames = getImportedFnNames(code, "createRouter");
        return transformRouter(
          code,
          filePath,
          routerFnNames,
          normalizePath(id),
        );
      } finally {
        counter?.record(id, performance.now() - start);
      }
    },
  };
}
