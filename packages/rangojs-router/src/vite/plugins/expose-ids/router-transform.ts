import type { Plugin } from "vite";
import MagicString from "magic-string";
import path from "node:path";
import { createHash } from "node:crypto";
import { normalizePath, findMatchingParen } from "../expose-id-utils.js";
import { getImportedFnNames } from "./export-analysis.js";

export function transformRouter(
  code: string,
  filePath: string,
  routerFnNames: string[],
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

  while ((match = pat.exec(code)) !== null) {
    const callStart = match.index;
    const parenPos = match.index + match[0].length - 1;

    // Scope the $$id check to within this call's arguments only,
    // not the entire remaining file.
    const closeParen = findMatchingParen(code, parenPos + 1);
    const callArgs = code.slice(parenPos + 1, closeParen);

    // Skip if $$id is already present in this call
    if (callArgs.includes("$$id")) continue;

    // Compute line number for this call
    const lineNumber = code.slice(0, callStart).split("\n").length;
    const hash = createHash("sha256")
      .update(`${filePath}:${lineNumber}`)
      .digest("hex")
      .slice(0, 8);

    changed = true;
    const injected = ` $$id: "${hash}", $$routeNames: ${routeNamesVar},`;

    const afterParen = callArgs.trimStart();
    if (afterParen.startsWith("{")) {
      const bracePos = code.indexOf("{", parenPos + 1);
      s.appendRight(bracePos + 1, injected);
    } else if (afterParen.startsWith(")")) {
      s.appendRight(parenPos + 1, `{${injected} }`);
    }
  }

  if (!changed) return null;

  // Prepend the static import as the first line. MagicString tracks the
  // offset so all downstream source maps remain correct.
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
  return {
    name: "@rangojs/router:expose-router-id",
    configResolved(config) {
      projectRoot = config.root;
    },
    transform(code, id) {
      if (!code.includes("createRouter")) return null;
      // Accepts both @rangojs/router and @rangojs/router/server subpath.
      // NOTE: detectImports in expose-id-utils has a stricter check that
      // excludes /server for its router flag -- that's intentional since
      // detectImports is only used in exposeInternalIds, not here.
      if (
        !/import\s*\{[^}]*\bcreateRouter\b[^}]*\}\s*from\s*["']@rangojs\/router(?:\/server)?["']/.test(
          code,
        )
      ) {
        return null;
      }
      if (id.includes("node_modules")) return null;

      const filePath = normalizePath(path.relative(projectRoot, id));
      const routerFnNames = getImportedFnNames(code, "createRouter");
      return transformRouter(code, filePath, routerFnNames);
    },
  };
}
