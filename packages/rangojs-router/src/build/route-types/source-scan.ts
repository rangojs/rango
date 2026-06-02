// Allocation-light, linear-time source scanning for the build-time scanners.
//
// The router-file scanner, the HMR relevance check, and the unsupported-shape
// warning all need to know whether a token like `createRouter(` / `createLoader(`
// appears in REAL code versus inside a comment or string literal. Rather than
// build a full comment/string-stripped copy of the source (which on a large
// file allocates an O(n) string plus, naively, a per-char array), these helpers
// run the regex over the whole source ONCE (the engine sweeps left-to-right,
// O(n)) and classify each match's offset with a forward, O(1)-memory cursor that
// advances monotonically across the source.
//
// Time: O(n) — one native regex sweep plus one forward classification pass.
// Memory: O(1) for the boolean check; O(#matches) for the index list. No
// stripped copy and no per-char array are ever materialized.
//
// Pragmatic scanner, not a full tokenizer: regex literals are not special-cased
// (a target token inside one is implausible) and template interpolations are
// treated as opaque string content. One intentional consequence: a token whose
// match would only complete by treating an interleaved comment as whitespace
// (e.g. `createRouter /* x */ (`) is not detected — real calls never interleave
// a comment between the callee and its arguments.

// JS line terminators end a `//` comment: LF, CR, LS (U+2028), PS (U+2029).
function isLineTerminator(ch: string): boolean {
  const c = ch.charCodeAt(0);
  // LF, CR, LS (U+2028), PS (U+2029)
  return c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
}

/**
 * Build a classifier that answers "is offset `q` in code (not a comment or
 * string)?" for STRICTLY INCREASING `q`. The internal cursor only moves forward,
 * so a full left-to-right sequence of queries costs O(n) total with O(1) memory.
 */
function makeCodeClassifier(code: string): (q: number) => boolean {
  const n = code.length;
  let i = 0; // forward cursor: everything before `i` is already classified
  let skipStart = -1; // last detected comment/string region (cache)
  let skipEnd = -1;

  return (q: number): boolean => {
    if (q >= skipStart && q < skipEnd) return false; // q in the cached region
    while (i < n && i <= q) {
      const c = code[i];
      const d = i + 1 < n ? code[i + 1] : "";
      let end = -1;
      if (c === "/" && d === "/") {
        let j = i + 2;
        while (j < n && !isLineTerminator(code[j])) j++;
        end = j;
      } else if (c === "/" && d === "*") {
        let j = i + 2;
        while (j < n && !(code[j] === "*" && code[j + 1] === "/")) j++;
        end = Math.min(n, j + 2);
      } else if (c === '"' || c === "'" || c === "`") {
        let j = i + 1;
        while (j < n) {
          if (code[j] === "\\") {
            j += 2;
            continue;
          }
          if (code[j] === c) {
            j++;
            break;
          }
          j++;
        }
        end = j;
      }
      if (end >= 0) {
        // Comment/string region [i, end). `q >= i` here (loop condition).
        if (q < end) {
          skipStart = i;
          skipEnd = end;
          return false;
        }
        i = end;
      } else {
        i++;
      }
    }
    return true; // reached q in code mode
  };
}

/**
 * Index of the first match of `pattern` that occurs in code (not in a comment
 * or string), or -1. `pattern` MUST be a global (`/g`) regex. Single native
 * regex sweep with early-exit; O(1) extra memory.
 */
export function firstCodeMatchIndex(code: string, pattern: RegExp): number {
  const inCode = makeCodeClassifier(code);
  pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(code)) !== null) {
    if (inCode(m.index)) return m.index;
    if (pattern.lastIndex <= m.index) pattern.lastIndex = m.index + 1;
  }
  return -1;
}

/**
 * Byte offsets of every match of `pattern` that occurs in code (not in a
 * comment or string). `pattern` MUST be a global (`/g`) regex. Each offset is
 * the match start — the same byte offset a raw `pattern.exec` reports. O(n)
 * time, O(#matches) memory.
 */
export function codeMatchIndices(code: string, pattern: RegExp): number[] {
  const inCode = makeCodeClassifier(code);
  const indices: number[] = [];
  pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(code)) !== null) {
    if (inCode(m.index)) indices.push(m.index);
    if (pattern.lastIndex <= m.index) pattern.lastIndex = m.index + 1;
  }
  return indices;
}
