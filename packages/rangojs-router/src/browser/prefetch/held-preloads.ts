/**
 * Held preloads of a speculative prefetch.
 *
 * A Flight payload carries React's resource hints as rows (`:HL[...]` for a
 * `preload()`), and the Flight client starts each one the moment it decodes
 * the row. A prefetch decodes its response eagerly (fetch.ts), so without
 * this module a viewport or render prefetch made the browser download every
 * image the target page preloads, before any click and on a page that shows
 * none of them.
 *
 * A hold filters the raw bytes before they are decoded: the response's, and
 * each stored segment fragment's the payload carries (segment-fragments.ts),
 * which is a Flight document of its own. It takes out the `preload` hint rows
 * of the resources a page can show late (images, media, fetches, documents),
 * keeps them, and passes every other byte through unchanged. The navigation
 * that serves the prefetch calls `release()`, which starts them through
 * react-dom's `preload`, the call the Flight client would have made. Left in
 * the stream, so started as before: `preload` of a style, a font or a script
 * (a page painted without them flashes unstyled text or waits on them), and
 * every other hint (`preinit` of the route's CSS, `preloadModule` of its
 * chunks, `preconnect`, `prefetchDNS`).
 *
 * The row grammar mirrors the Flight client's reader
 * (react-server-dom-webpack-client, startReadingFromStream): a hex row id up
 * to `:`, then a tag; a binary tag is followed by a hex byte length, `,` and
 * that many bytes; any other row runs to `\n`.
 */

import { preload, type PreloadOptions } from "react-dom";

/** The arguments of a held `preload()`: href, `as` and its options. */
type PreloadHint = [href: string, as: string, options?: object];

/**
 * A speculative prefetch's held preloads (DecodedPrefetch.heldPreloads). Both
 * members are closures over the hold, safe to pass on detached.
 */
export interface HeldPreloads {
  /**
   * `body` without the preload rows the hold keeps. One call per Flight
   * stream: the response's, and each segment fragment's.
   */
  readonly filter: (
    body: ReadableStream<Uint8Array>,
  ) => ReadableStream<Uint8Array>;
  /**
   * Start every held preload, and from now on each one a filtered stream
   * meets as it arrives. Called by the navigation that serves the prefetch;
   * idempotent, and react-dom dedupes a preload it already started.
   */
  readonly release: () => void;
}

/** `preload()` destinations a speculative prefetch still starts. */
const PRELOAD_EAGERLY: ReadonlySet<string> = new Set([
  "style",
  "font",
  "script",
]);

/**
 * The tags whose row is a hex byte length, `,` and that many bytes, with no
 * `\n`: the Flight client reader's list (pinned by
 * src/__tests__/prefetch-held-preloads.test.ts).
 */
export const FLIGHT_BINARY_ROW_TAGS = "TAOobUSsLlGgMmV";

const BINARY_TAGS: ReadonlySet<number> = new Set(
  [...FLIGHT_BINARY_ROW_TAGS].map((c) => c.charCodeAt(0)),
);
const COLON = 0x3a;
const COMMA = 0x2c;
const NEWLINE = 0x0a;
const TAG_HINT = 0x48; // "H"
const CODE_PRELOAD = 0x4c; // "L"

/** The filter's place in the current row. */
const Row = {
  /** Reading the row id, up to `:`. */
  Id: 0,
  /** The byte after `:`: a tag, or the row's first data byte. */
  Tag: 1,
  /** A binary row's hex length, up to `,`. */
  Length: 2,
  /** A binary row's bytes. */
  Binary: 3,
  /** A row that runs to `\n`, passed through. */
  Text: 4,
  /** A hint row's code, the byte after `H`. */
  HintCode: 5,
  /** A preload hint row, buffered to its `\n` to decide whether it is held. */
  Hint: 6,
} as const;
type RowState = (typeof Row)[keyof typeof Row];

function hexDigit(byte: number): number {
  return byte > 96 ? byte - 87 : byte - 48;
}

/**
 * The `preload` an `L` hint row asks for when the hold keeps it: one whose
 * destination is not one PRELOAD_EAGERLY names. Null for any other, including
 * a row that does not parse (the decoder sees it as it came).
 */
function heldPreload(row: string): PreloadHint | null {
  // `<id>:HL[...]\n`: the model follows the code; the id is empty in practice.
  const tagAt = row.indexOf(":");
  let model: unknown;
  try {
    model = JSON.parse(row.slice(tagAt + 3));
  } catch {
    return null;
  }
  if (
    !Array.isArray(model) ||
    typeof model[0] !== "string" ||
    typeof model[1] !== "string" ||
    PRELOAD_EAGERLY.has(model[1])
  ) {
    return null;
  }
  const options: unknown = model[2];
  return options !== null && typeof options === "object"
    ? [model[0], model[1], options]
    : [model[0], model[1]];
}

function startPreload([href, as, options]: PreloadHint): void {
  preload(href, { ...options, as } as PreloadOptions);
}

/**
 * A stream transform that takes the held preload rows out of one Flight
 * stream and hands each to `hold`.
 */
function holdRows(
  hold: (hint: PreloadHint) => void,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let state: RowState = Row.Id;
  let binaryLength = 0;
  // A row's id and tag bytes, kept until the tag says whether it is a hint
  // row; then the whole hint row, to its `\n`.
  let rowBytes: Uint8Array[] = [];
  const passRowBytes = (
    controller: TransformStreamDefaultController<Uint8Array>,
  ) => {
    for (const part of rowBytes) controller.enqueue(part);
    rowBytes = [];
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // Start of this chunk's bytes not yet passed on or kept in rowBytes.
      let from = 0;
      let i = 0;
      while (i < chunk.length) {
        switch (state) {
          case Row.Id: {
            const colon = chunk.indexOf(COLON, i);
            const end = colon === -1 ? chunk.length : colon + 1;
            if (i > from) controller.enqueue(chunk.subarray(from, i));
            rowBytes.push(chunk.subarray(i, end));
            from = i = end;
            if (colon !== -1) state = Row.Tag;
            break;
          }
          case Row.Tag: {
            const tag = chunk[i]!;
            if (tag === TAG_HINT) {
              rowBytes.push(chunk.subarray(i, i + 1));
              from = i = i + 1;
              state = Row.HintCode;
              break;
            }
            // Not a hint row: its id and `:` pass on, then the row itself.
            passRowBytes(controller);
            if (BINARY_TAGS.has(tag)) {
              i++;
              binaryLength = 0;
              state = Row.Length;
            } else {
              state = Row.Text;
            }
            break;
          }
          case Row.Length: {
            const byte = chunk[i++]!;
            if (byte === COMMA) state = Row.Binary;
            else binaryLength = (binaryLength << 4) | hexDigit(byte);
            break;
          }
          case Row.Binary: {
            const take = Math.min(binaryLength, chunk.length - i);
            i += take;
            binaryLength -= take;
            if (binaryLength === 0) state = Row.Id;
            break;
          }
          case Row.Text: {
            const newline = chunk.indexOf(NEWLINE, i);
            if (newline === -1) {
              i = chunk.length;
            } else {
              i = newline + 1;
              state = Row.Id;
            }
            break;
          }
          case Row.HintCode: {
            if (chunk[i] === CODE_PRELOAD) {
              state = Row.Hint;
              break;
            }
            // Any other hint passes on as it is, its id and tag first.
            passRowBytes(controller);
            state = Row.Text;
            break;
          }
          case Row.Hint: {
            const newline = chunk.indexOf(NEWLINE, i);
            const end = newline === -1 ? chunk.length : newline + 1;
            rowBytes.push(chunk.subarray(i, end));
            from = i = end;
            if (newline === -1) break;
            state = Row.Id;
            let row = "";
            for (const part of rowBytes) {
              row += decoder.decode(part, { stream: true });
            }
            row += decoder.decode();
            const hint = heldPreload(row);
            if (hint) {
              hold(hint);
              rowBytes = [];
            } else {
              passRowBytes(controller);
            }
            break;
          }
        }
      }
      if (chunk.length > from) controller.enqueue(chunk.subarray(from));
    },
    flush(controller) {
      // A stream that ends inside a row's prefix or a hint row: the decoder
      // gets the bytes as they came.
      passRowBytes(controller);
    },
  });
}

/** A new hold, for one speculative prefetch and every decode of its bytes. */
export function holdPreloads(): HeldPreloads {
  const pending: PreloadHint[] = [];
  let released = false;
  const hold = (hint: PreloadHint) => {
    if (released) startPreload(hint);
    else pending.push(hint);
  };
  return {
    filter: (body) => body.pipeThrough(holdRows(hold)),
    release: () => {
      if (released) return;
      released = true;
      for (const hint of pending.splice(0)) startPreload(hint);
    },
  };
}
