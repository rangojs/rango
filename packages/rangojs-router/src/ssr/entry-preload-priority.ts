/**
 * The client entry's head hint at default fetch priority, after the head chunk
 * scripts (issue #1025).
 *
 * For `bootstrapModules`, Fizz writes `<link rel="modulepreload"
 * fetchPriority="low">` into the head and claims the URL
 * (`moduleScriptResources[url] = null`, react-dom 19.3.0
 * `react-dom-server.edge.production.js:546-565`) before the render starts, so
 * no `preloadModule`/`preinitModule` call can replace it, and the
 * `bootstrapModules` entry shape has no priority field. Chromium fetches that
 * hint at Low, and once it boosts in-viewport images to High after first
 * layout, the entry queues behind them; the executing end-of-shell module
 * script reuses the in-flight Low fetch through the module map. Hydration
 * then waits on a few-hundred-byte file while the head chunk scripts it
 * imports (High) have long arrived: measured +3.8 s on a priority-honouring
 * HTTP/2 link at Slow 4G.
 *
 * The fix serves that one tag without the attribute, so it fetches at
 * Chromium's modulepreload default (High), and moves it after the head
 * chunk scripts. Fizz flushes the bootstrap hint before the head chunk scripts; at
 * High in that position it took one of HTTP/1.1's six connections ahead of
 * the react chunk and delayed the last head chunk (hydration +91 ms, LCP
 * +84 ms measured). After the scripts it is the last High request in the
 * queue, so it never displaces a chunk hydration also needs. The accepted
 * cost: an HTTP/2 server that sends equal-priority streams first in, first
 * out delivers it with the last head chunk instead of before it (text-only
 * pages +12 to +56 ms measured, against -0.15 to -3.3 s hydration on image
 * pages; CHANGELOG has the matrix). Everything else about the bootstrap pair
 * stays Fizz's: the nonce, the executing `id="_R_"` tag, the URL claim that
 * keeps plugin-rsc's and the preinit hook's calls for the entry inert, and the
 * PPR prelude/resume behaviour.
 *
 * The match is the exact tag Fizz writes for a string `bootstrapModules`
 * entry (`rel`, `fetchPriority`, `nonce`, `href` in that order), not a
 * pattern, and only before the first `<body`. A Fizz version that writes it
 * differently leaves the bytes untouched: the output keeps the Low hint.
 *
 * Where the tag goes: right after the run of Fizz resource tags that directly
 * follows the hint, before the first token that is anything else (`</head>`,
 * the app's own head children, or body content in a head-less document).
 * Fizz flushes the head chunk scripts and the bulk preloads straight after
 * the bootstrap hint (react-dom 19.3.0 `flushCompletedQueues`, `:7321-7325`),
 * as `<script …></script>` with no body and `<link …/>`; the scan accepts
 * only those two shapes and stops at any other token without reading into it.
 * It never searches the app's head content for `</head>` or `<body`: React
 * does not escape either inside `<script>` or `<style>` text, so a head script
 * holding the string `"<body>"` once received the tag inside its source and
 * threw. Fizz escapes `>` in attribute values, so the first `>` ends a tag.
 * Every insertion point is the boundary between two complete tags; a stream
 * that ends mid-run, or a run tag longer than {@link MAX_HELD_TAG}, gets the
 * tag before the unfinished one. Only that one tag is held back while the run
 * streams; each complete run tag is forwarded as soon as it is scanned.
 */

const LOW_PRIORITY_ATTR = ' fetchPriority="low"';
const encoder = new TextEncoder();
const BODY_OPEN = encoder.encode("<body");
const LINK_OPEN = encoder.encode("<link");
const SCRIPT_OPEN = encoder.encode("<script");
const SCRIPT_CLOSE = encoder.encode("</script>");
const GT = 0x3e;

/**
 * Longest run tag held while its end has not arrived. Fizz's chunk scripts
 * and preload links are a few hundred bytes; past this the tag goes before
 * the held one, which keeps the per-chunk work bounded.
 */
const MAX_HELD_TAG = 8192;

/** React's escapeTextForBrowser: the attribute escaping Fizz applies. */
function escapeAttr(value: string): string {
  return value.replace(/["&'<>]/g, (c) =>
    c === '"'
      ? "&quot;"
      : c === "&"
        ? "&amp;"
        : c === "'"
          ? "&#x27;"
          : c === "<"
            ? "&lt;"
            : "&gt;",
  );
}

interface EntryHintBytes {
  low: Uint8Array;
  auto: Uint8Array;
}

function entryHintBytes(
  entryUrl: string,
  nonce: string | undefined,
): EntryHintBytes {
  const tail =
    (nonce ? ` nonce="${escapeAttr(nonce)}"` : "") +
    ` href="${escapeAttr(entryUrl)}"/>`;
  return {
    low: encoder.encode(`<link rel="modulepreload"${LOW_PRIORITY_ATTR}${tail}`),
    auto: encoder.encode(`<link rel="modulepreload"${tail}`),
  };
}

function indexOfBytes(
  haystack: Uint8Array,
  needle: Uint8Array,
  from = 0,
): number {
  const first = needle[0];
  const last = haystack.length - needle.length;
  outer: for (let i = from; i <= last; i++) {
    if (haystack[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Length of the longest suffix of `buf` that is a proper prefix of `needle`:
 * the bytes a chunk boundary may have split off a match.
 */
function partialSuffixLength(buf: Uint8Array, needle: Uint8Array): number {
  const max = Math.min(buf.length, needle.length - 1);
  outer: for (let len = max; len > 0; len--) {
    const start = buf.length - len;
    for (let j = 0; j < len; j++) {
      if (buf[start + j] !== needle[j]) continue outer;
    }
    return len;
  }
  return 0;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Index of the hint in `buf` when it precedes the first `<body`, else -1. */
function findHint(buf: Uint8Array, hint: EntryHintBytes): number {
  const bodyAt = indexOfBytes(buf, BODY_OPEN);
  return indexOfBytes(bodyAt === -1 ? buf : buf.subarray(0, bodyAt), hint.low);
}

/**
 * 1 when `needle` starts at `pos`, 0 when it does not, -1 when `buf` ends
 * before that can be decided (the available bytes match a prefix).
 */
function matchAt(buf: Uint8Array, pos: number, needle: Uint8Array): number {
  const n = Math.min(needle.length, buf.length - pos);
  for (let j = 0; j < n; j++) {
    if (buf[pos + j] !== needle[j]) return 0;
  }
  return n === needle.length ? 1 : -1;
}

/** HTML whitespace, `/` or `>`: the byte that ends a tag name. */
function endsTagName(byte: number): boolean {
  return (
    byte === 0x20 ||
    byte === 0x09 ||
    byte === 0x0a ||
    byte === 0x0c ||
    byte === 0x0d ||
    byte === 0x2f ||
    byte === GT
  );
}

interface RunScan {
  /** The run ended: `at` is the first byte of the token after it. */
  ended: boolean;
  /** Insertion point, or the start of the unfinished token when not ended. */
  at: number;
}

/**
 * Skip the run of Fizz resource tags at the start of `buf`: `<link …>` and
 * `<script …></script>` with nothing between the two tags.
 */
function scanRun(buf: Uint8Array): RunScan {
  let pos = 0;
  while (pos < buf.length) {
    const link = matchAt(buf, pos, LINK_OPEN);
    const script = link === 1 ? 0 : matchAt(buf, pos, SCRIPT_OPEN);
    if (link !== 1 && script !== 1) {
      return { ended: link === 0 && script === 0, at: pos };
    }
    const nameEnd = pos + (link === 1 ? LINK_OPEN.length : SCRIPT_OPEN.length);
    if (nameEnd >= buf.length) return { ended: false, at: pos };
    if (!endsTagName(buf[nameEnd]!)) return { ended: true, at: pos };
    const gt = buf.indexOf(GT, nameEnd);
    if (gt === -1) return { ended: false, at: pos };
    let end = gt + 1;
    if (script === 1) {
      const close = matchAt(buf, end, SCRIPT_CLOSE);
      // An inline script body: the hint goes before the <script, never in it.
      if (close !== 1) return { ended: close === 0, at: pos };
      end += SCRIPT_CLOSE.length;
    }
    pos = end;
  }
  return { ended: false, at: pos };
}

/** `rest` with `hint` inserted at `at`. */
function insertAt(rest: Uint8Array, at: number, hint: Uint8Array): Uint8Array {
  const out = new Uint8Array(rest.length + hint.length);
  out.set(rest.subarray(0, at), 0);
  out.set(hint, at);
  out.set(rest.subarray(at), at + hint.length);
  return out;
}

/**
 * Rewrite a complete document prefix (the PPR shell capture's prelude).
 * Returns `bytes` unchanged when no hint precedes the first `<body`.
 */
export function rewriteEntryPreloadPriority(
  bytes: Uint8Array,
  entryUrl: string,
  nonce?: string,
): Uint8Array {
  const hint = entryHintBytes(entryUrl, nonce);
  const at = findHint(bytes, hint);
  if (at === -1) return bytes;
  const rest = bytes.subarray(at + hint.low.length);
  return concat(
    bytes.subarray(0, at),
    insertAt(rest, scanRun(rest).at, hint.auto),
  );
}

/**
 * Streaming form for live SSR: the same rewrite as
 * {@link rewriteEntryPreloadPriority}, then pass-through. Before the hint is
 * found, only a chunk tail that may be the start of a split `<body` or hint
 * tag is held back. After it, complete run tags are forwarded as they are
 * scanned and only an unfinished one (at most {@link MAX_HELD_TAG} bytes) is
 * held, so every byte is scanned a bounded number of times. Once the tag is
 * placed, or once `<body` passes without a hint, chunks are forwarded
 * untouched and unscanned.
 */
export function entryPreloadPriorityTransform(
  entryUrl: string,
  nonce?: string,
): TransformStream<Uint8Array, Uint8Array> {
  const hint = entryHintBytes(entryUrl, nonce);
  let carry: Uint8Array | null = null;
  // The unfinished run tag after the removed hint (possibly empty).
  let held: Uint8Array | null = null;
  let done = false;
  const place = (
    rest: Uint8Array,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    const scan = scanRun(rest);
    if (scan.ended || rest.length - scan.at > MAX_HELD_TAG) {
      done = true;
      held = null;
      controller.enqueue(insertAt(rest, scan.at, hint.auto));
      return;
    }
    if (scan.at > 0) controller.enqueue(rest.slice(0, scan.at));
    held = rest.slice(scan.at);
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (done) {
        controller.enqueue(chunk);
        return;
      }
      if (held) {
        place(concat(held, chunk), controller);
        return;
      }
      const buf: Uint8Array = carry ? concat(carry, chunk) : chunk;
      carry = null;
      const at = findHint(buf, hint);
      if (at !== -1) {
        if (at > 0) controller.enqueue(buf.slice(0, at));
        place(buf.subarray(at + hint.low.length), controller);
        return;
      }
      if (indexOfBytes(buf, BODY_OPEN) !== -1) {
        done = true;
        controller.enqueue(buf);
        return;
      }
      const hold = Math.max(
        partialSuffixLength(buf, hint.low),
        partialSuffixLength(buf, BODY_OPEN),
      );
      if (hold > 0) carry = buf.slice(buf.length - hold);
      const out = hold > 0 ? buf.subarray(0, buf.length - hold) : buf;
      if (out.length > 0) controller.enqueue(out);
    },
    flush(controller) {
      if (carry) controller.enqueue(carry);
      // The stream ended inside the run: the tag goes before the unfinished one.
      if (held) controller.enqueue(concat(hint.auto, held));
    },
  });
}
