import type { Plugin } from "vite";
import MagicString from "magic-string";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  normalizePath,
  findMatchingParen,
  findCallParenAfterGenerics,
  skipStringOrComment,
} from "../expose-id-utils.js";
import { escapeRegExp } from "../../../regex-escape.js";
import {
  getImportedFnNames,
  buildUnsupportedShapeWarning,
} from "./export-analysis.js";
import { codeMatchIndices } from "../../../build/route-types/source-scan.js";
import { createRangoDebugger, createCounter, NS } from "../../debug.js";

const debug = createRangoDebugger(NS.transform);

/**
 * Advance past leading whitespace and a single leading line/block comment so a
 * `createRouter(/* opts *\/ { ... })` call still resolves to its `{`. Only the
 * first comment-or-whitespace run is skipped (enough for the common prefix
 * case); a non-trivia token after it stops the scan.
 */
function skipLeadingTrivia(code: string, start: number, end: number): number {
  let i = start;
  while (i < end) {
    const skipped = skipStringOrComment(code, i);
    // skipStringOrComment only advances for strings/comments, not whitespace.
    if (skipped > i) {
      i = skipped;
      continue;
    }
    if (/\s/.test(code[i])) {
      i++;
      continue;
    }
    break;
  }
  return i;
}

export function transformRouter(
  code: string,
  filePath: string,
  routerFnNames: string[],
  absolutePath?: string,
  warn?: (message: string) => void,
): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  // Match only the callee identifier; the generic list (which may be nested,
  // e.g. createRouter<Config<Env>>(...)) and the opening paren are located
  // separately via findCallParenAfterGenerics so a nested `>` does not defeat
  // the scan (a `<[^>]*>` regex stopped at the first `>`).
  const pat = new RegExp(
    `\\b(?:${routerFnNames.map(escapeRegExp).join("|")})\\b`,
    "g",
  );
  let match: RegExpExecArray | null;
  const s = new MagicString(code);
  let changed = false;
  const unsupportedSites: Array<{ line: number; column: number }> = [];

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
    const calleeEnd = match.index + match[0].length;

    // Resolve the call's opening paren, skipping an optional (possibly nested)
    // generic argument list. A non-call reference (e.g. a bare identifier or a
    // type position) yields -1 and is skipped.
    const parenPos = findCallParenAfterGenerics(code, calleeEnd);
    if (parenPos === -1) continue;

    const closeParen = findMatchingParen(code, parenPos + 1);
    const callArgs = code.slice(parenPos + 1, closeParen);

    // Skip ONLY a call we already injected into. The injected marker is the
    // unique `$$routeNames: <var>` property; a bare `$$id` substring check
    // would also match a user value/comment that merely contains the text
    // "$$id" (e.g. `createRouter({ meta: { note: "see $$id docs" } })`),
    // silently dropping named-route wiring for a legitimate config.
    if (callArgs.includes(`$$routeNames: ${routeNamesVar}`)) continue;

    const sourceFilePath = absolutePath ?? filePath;
    const lineNumber = code.slice(0, callStart).split("\n").length;
    const hash = createHash("sha256")
      .update(`${filePath}:${lineNumber}`)
      .digest("hex")
      .slice(0, 8);
    const injected = ` $$id: "${hash}", $$sourceFile: "${sourceFilePath}", $$routeNames: ${routeNamesVar},`;

    // Skip a leading comment/whitespace run so `createRouter(/* c *\/ {...})`
    // and a newline-then-comment prefix still resolve to the object literal.
    // findMatchingParen returns one past the close `)`, so the matching paren
    // sits at closeParen - 1 and empty args resolve to that `)`.
    const argsContentStart = skipLeadingTrivia(code, parenPos + 1, closeParen);
    const firstArgChar = code[argsContentStart];

    if (firstArgChar === "{") {
      changed = true;
      s.appendRight(argsContentStart + 1, injected);
    } else if (argsContentStart >= closeParen - 1) {
      // Empty args: createRouter(). Wrap a fresh config object.
      changed = true;
      s.appendRight(parenPos + 1, `{${injected} }`);
    } else {
      // Unsupported argument shape (bare identifier, spread, call, etc.). No
      // stable $$id can be injected here. Record it so the plugin can warn —
      // and crucially do NOT mark changed, so a dead named-routes.gen import is
      // not prepended for a call we never touched.
      const lastNl = code.lastIndexOf("\n", callStart - 1);
      const column = callStart - (lastNl + 1) + 1;
      unsupportedSites.push({ line: lineNumber, column });
    }
  }

  if (unsupportedSites.length > 0 && warn) {
    warn(
      buildUnsupportedShapeWarning(filePath, "createRouter", unsupportedSites),
    );
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
        const warn =
          typeof this.warn === "function"
            ? (message: string) => this.warn(message)
            : undefined;
        return transformRouter(
          code,
          filePath,
          routerFnNames,
          normalizePath(id),
          warn,
        );
      } finally {
        counter?.record(id, performance.now() - start);
      }
    },
  };
}
