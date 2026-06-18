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
// Pragmatic scanner, not a full tokenizer: regex literals ARE coarsely skipped
// (see below) and template interpolations are treated as opaque string content.
// One intentional consequence: a token whose match would only complete by
// treating an interleaved comment as whitespace (e.g. `createRouter /* x */ (`)
// is not detected — real calls never interleave a comment between the callee
// and its arguments.
//
// Regex literals are skipped because a literal containing a quote or comment
// char (e.g. `const re = /it's a "x"/g;`) would otherwise open a phantom string
// at the inner quote and swallow the following REAL code — dropping a router
// file from discovery. We only treat a `/` as a regex start when it is in
// "regex position" (the previous significant code char is not value-producing),
// so genuine division (`a / b`) is left untouched.

// JS line terminators end a `//` comment: LF, CR, LS (U+2028), PS (U+2029).
function isLineTerminator(ch: string): boolean {
  const c = ch.charCodeAt(0);
  // LF, CR, LS (U+2028), PS (U+2029)
  return c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
}

// A `/` is a regex-literal start (not division) when the previous significant
// code char cannot end an expression. Value-producing terminators are
// identifiers/digits, a closing `)`/`]`, and `$`/`_`; everything else (operators,
// `(`, `,`, `=`, `:`, `{`, `;`, `<`, `>`, ...) and the start-of-file put `/` in
// regex position. Conservative: a false negative only reverts to the old
// behavior, and a false positive on real division is avoided because division's
// left operand always ends in a value-producing char. `}` is treated as
// value-producing to avoid swallowing an object/block followed by division;
// the cost is only that a regex right after a block isn't skipped (rare, and
// merely the prior behavior).
function isRegexPositionPrev(ch: string | undefined): boolean {
  if (ch === undefined) return true; // start of file
  if (ch === ")" || ch === "]" || ch === "}") return false;
  // Identifier/number continuation chars are value-producing.
  return !/[\w$]/.test(ch);
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
  // Last significant code char, used to disambiguate `/` (regex vs division).
  // Comments are transparent (don't update it); strings/regex are value-producing.
  let lastSig: string | undefined;

  return (q: number): boolean => {
    if (q >= skipStart && q < skipEnd) return false; // q in the cached region
    while (i < n && i <= q) {
      const c = code[i];
      const d = i + 1 < n ? code[i + 1] : "";
      let end = -1;
      let transparent = false; // comment: skipped but does not set lastSig
      if (c === "/" && d === "/") {
        let j = i + 2;
        while (j < n && !isLineTerminator(code[j])) j++;
        end = j;
        transparent = true;
      } else if (c === "/" && d === "*") {
        let j = i + 2;
        while (j < n && !(code[j] === "*" && code[j + 1] === "/")) j++;
        end = Math.min(n, j + 2);
        transparent = true;
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
      } else if (
        c === "/" &&
        d !== "/" &&
        d !== "*" &&
        isRegexPositionPrev(lastSig)
      ) {
        // Coarse regex-literal skip. A regex literal cannot span a raw newline;
        // `/` inside a `[...]` character class is literal (not a terminator).
        // Bail (treat the `/` as a normal char) if no closing `/` on the line
        // so a stray division-looking `/` never swallows the rest of the line.
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < n && !isLineTerminator(code[j])) {
          const r = code[j];
          if (r === "\\") {
            j += 2;
            continue;
          }
          if (r === "[") inClass = true;
          else if (r === "]") inClass = false;
          else if (r === "/" && !inClass) {
            j++;
            closed = true;
            break;
          }
          j++;
        }
        if (closed) {
          while (j < n && /[a-z]/.test(code[j])) j++; // flags
          end = j;
        }
      }
      if (end >= 0) {
        // Comment/string/regex region [i, end). `q >= i` here (loop condition).
        if (q < end) {
          skipStart = i;
          skipEnd = end;
          return false;
        }
        i = end;
        // Strings and regex literals are value-producing; comments are not.
        if (!transparent) lastSig = "x";
      } else {
        if (!/\s/.test(c)) lastSig = c;
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
