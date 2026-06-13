import {
  skipStringOrComment,
  escapeRegExp,
} from "../plugins/expose-id-utils.js";

/**
 * Find matching close paren in bundled code using depth counting.
 * Uses skipStringOrComment to correctly handle template literals, comments, and nested strings.
 * @internal Exported for testing only.
 */
export function findMatchingParenInBundle(
  code: string,
  openParenPos: number,
): number {
  let depth = 1;
  let pos = openParenPos;
  while (pos < code.length && depth > 0) {
    const skipped = skipStringOrComment(code, pos);
    if (skipped > pos) {
      pos = skipped;
      continue;
    }
    if (code[pos] === "(") depth++;
    else if (code[pos] === ")") depth--;
    pos++;
  }
  return depth === 0 ? pos : -1;
}

/**
 * Scan a bundled chunk for handler exports and extract their names + $$id values.
 * Optionally detects passthrough flag. @internal Exported for testing only.
 */
export function extractHandlerExportsFromChunk(
  chunkCode: string,
  handlerModules: Map<string, string[]>,
  fnName: string,
  detectPassthrough: boolean,
): Array<{ name: string; handlerId: string; passthrough: boolean }> {
  const handlers: Array<{
    name: string;
    handlerId: string;
    passthrough: boolean;
  }> = [];

  for (const [, handlerNames] of handlerModules) {
    for (const name of handlerNames) {
      const eName = escapeRegExp(name);
      const idPattern = new RegExp(
        `(?<![a-zA-Z0-9_])${eName}\\.\\$\\$id\\s*=\\s*"([^"]+)"`,
      );
      const match = chunkCode.match(idPattern);
      if (!match) continue;

      let isPassthrough = false;
      if (detectPassthrough) {
        const eFnName = escapeRegExp(fnName);
        const callStartRe = new RegExp(
          `(?:const|let|var)\\s+${eName}\\s*=\\s*${eFnName}\\s*(?:<[^>]*>)?\\s*\\(`,
        );
        const callStart = callStartRe.exec(chunkCode);
        if (callStart) {
          const afterOpen = callStart.index + callStart[0].length;
          const closePos = findMatchingParenInBundle(chunkCode, afterOpen);
          if (closePos !== -1) {
            const callBody = chunkCode.slice(callStart.index, closePos);
            isPassthrough = /passthrough\s*:\s*(!0|true)/.test(callBody); // !0 is minified true
          }
        }
      }
      handlers.push({ name, handlerId: match[1], passthrough: isPassthrough });
    }
  }

  return handlers;
}

/**
 * Evict handler code from a bundled chunk, replacing full call expressions with stubs.
 * Returns the modified code and bytes saved, or null if no changes were made.
 * @internal Exported for testing only.
 */
export function evictHandlerCode(
  code: string,
  exports: Array<{ name: string; handlerId: string; passthrough?: boolean }>,
  fnName: string,
  brand: string,
): { code: string; savedBytes: number } | null {
  const originalSize = Buffer.byteLength(code);
  let modified = code;

  const eFnName = escapeRegExp(fnName);
  for (const { name, handlerId, passthrough } of exports) {
    if (passthrough) continue;

    const eName = escapeRegExp(name);
    // Match const/let/var: Rolldown (Vite 8) emits top-level bindings in the
    // non-minified RSC bundle as `var`, whereas Rollup used `const`.
    const callStartRe = new RegExp(
      `(?:const|let|var)\\s+${eName}\\s*=\\s*${eFnName}\\s*(?:<[^>]*>)?\\s*\\(`,
    );
    const startMatch = callStartRe.exec(modified);
    if (!startMatch) continue;

    const afterOpen = startMatch.index + startMatch[0].length;
    const closePos = findMatchingParenInBundle(modified, afterOpen);
    if (closePos === -1) continue;

    let rangeEnd = closePos;
    while (rangeEnd < modified.length && /\s/.test(modified[rangeEnd]))
      rangeEnd++;
    if (modified[rangeEnd] === ";") rangeEnd++;

    const matched = modified.slice(startMatch.index, rangeEnd);
    if (!matched.includes(handlerId)) continue;

    const stub = `const ${name} = { __brand: "${brand}", $$id: "${handlerId}" };`;
    modified =
      modified.slice(0, startMatch.index) + stub + modified.slice(rangeEnd);

    modified = modified.replace(
      new RegExp(`\\n${eName}\\.\\$\\$id\\s*=\\s*"[^"]+";`),
      "",
    );
  }

  if (modified === code) return null;
  return {
    code: modified,
    savedBytes: originalSize - Buffer.byteLength(modified),
  };
}
