/**
 * Prelude-first binary layout of a CFCacheStore PPR shell entry, shared by the
 * Cache API body and the KV value (issue #941; docs/design/shell-entry-layout.md):
 *
 *   "RSH1" | head length, 8 hex digits | head JSON | prelude bytes | snapshot JSON
 *
 * A document HIT needs the head (versions, freshness, tags, postponed) and the
 * raw prelude before its first byte, and the capture snapshot only in the
 * tail. Laying them out in that order lets the serve path read the head,
 * start the tag-marker read, read exactly `pl` prelude bytes, and commit while
 * the snapshot bytes are still arriving. One record keeps the prelude and the
 * snapshot generation-coupled by construction: a Cache API entry and a KV
 * value are written and read whole, so a split read can never pair one
 * capture's prelude with another's pins.
 *
 * Every byte is UTF-8 text when the prelude is (React's HTML through
 * TextEncoder always is), so the KV value is stored as a string (the
 * KVNamespace contract's `put(key, string)`) and read back as the same bytes
 * with `{ type: "stream" }`.
 */

import type { ShellSnapshotRecord } from "../types.js";

const MAGIC = [0x52, 0x53, 0x48, 0x31]; // "RSH1"
/** Magic (4) + head length as 8 hex digits (8). */
const PREFIX_BYTES = 12;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const strictTextDecoder = new TextDecoder("utf-8", { fatal: true });

/** The frame head: every entry field except the prelude and the snapshot. */
export interface ShellFrameHead {
  /** ShellCacheEntry.reactVersion */
  rv: string;
  /** ShellCacheEntry.buildVersion */
  bv?: string;
  /** Capture-generation start time (ms epoch), used by tag marker checks. */
  c: number;
  /** When the entry becomes stale (ms epoch). */
  s: number;
  /** When the entry hard-expires (ms epoch). */
  e: number;
  /** Cache tags (for distributed tag invalidation). */
  t?: string[];
  /** Timestamp when tags were attached (ms epoch). */
  ta?: number;
  /** ShellCacheEntry.initialTheme */
  i?: string;
  /** ShellCacheEntry.docKey; navigation replay needs it after any round trip. */
  dk?: string;
  /** ShellCacheEntry.handlerLiveHoles; arms or declines the handler-free fast path. */
  lh?: boolean;
  /** ShellCacheEntry.transitionWhen */
  tw?: true;
  /** ShellCacheEntry.navigationOnly; its partial-context prelude is not document-safe. */
  no?: true;
  /** ShellCacheEntry.postponed. Absent iff `no` (no document half is stored). */
  po?: string | null;
  /** Prelude byte length (0 for a navigationOnly entry). */
  pl: number;
  /**
   * Snapshot byte length (0 when the entry has none). A body whose snapshot
   * part is any other length was truncated or corrupted.
   */
  sl: number;
}

/** Validate a parsed head before any field reaches the serve path. */
function isShellFrameHead(value: unknown): value is ShellFrameHead {
  if (value == null || typeof value !== "object") return false;
  const head = value as Partial<ShellFrameHead>;
  return (
    typeof head.rv === "string" &&
    (head.bv === undefined || typeof head.bv === "string") &&
    isFiniteNumber(head.c) &&
    isFiniteNumber(head.s) &&
    isFiniteNumber(head.e) &&
    (head.t === undefined ||
      (Array.isArray(head.t) &&
        head.t.every((tag) => typeof tag === "string"))) &&
    (head.ta === undefined || isFiniteNumber(head.ta)) &&
    (head.i === undefined || typeof head.i === "string") &&
    (head.dk === undefined || typeof head.dk === "string") &&
    (head.lh === undefined || typeof head.lh === "boolean") &&
    (head.tw === undefined || head.tw === true) &&
    (head.no === undefined || head.no === true) &&
    // Document half: postponed is required unless the entry is navigationOnly.
    (head.po === null ||
      typeof head.po === "string" ||
      (head.po === undefined && head.no === true)) &&
    isByteLength(head.pl) &&
    isByteLength(head.sl)
  );
}

function isByteLength(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Serialize a shell entry into one prelude-first frame. Throws when the head's
 * byte lengths (`pl`, `sl`) do not describe `prelude` and `snapshot`.
 */
export function encodeShellFrame(
  head: ShellFrameHead,
  prelude: Uint8Array,
  snapshot?: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const snapshotLength = snapshot?.length ?? 0;
  if (head.pl !== prelude.length || head.sl !== snapshotLength) {
    throw new Error("shell frame head does not match its prelude/snapshot");
  }
  const headBytes = textEncoder.encode(JSON.stringify(head));
  const frame = new Uint8Array(
    PREFIX_BYTES + headBytes.length + prelude.length + snapshotLength,
  );
  frame.set(MAGIC, 0);
  frame.set(
    textEncoder.encode(headBytes.length.toString(16).padStart(8, "0")),
    MAGIC.length,
  );
  frame.set(headBytes, PREFIX_BYTES);
  frame.set(prelude, PREFIX_BYTES + headBytes.length);
  if (snapshot) {
    frame.set(snapshot, PREFIX_BYTES + headBytes.length + prelude.length);
  }
  return frame;
}

/**
 * The frame as the string KV stores. Throws when the prelude is not valid
 * UTF-8, which would not round-trip through a string.
 */
export function shellFrameToText(frame: Uint8Array): string {
  return strictTextDecoder.decode(frame);
}

/** UTF-8 JSON of a snapshot, or undefined when there is none to store. */
export function encodeShellSnapshot(
  snapshot: ShellSnapshotRecord[] | undefined,
): Uint8Array | undefined {
  return snapshot && snapshot.length > 0
    ? textEncoder.encode(JSON.stringify(snapshot))
    : undefined;
}

/**
 * Parse the snapshot bytes that follow the prelude. Zero bytes means the entry
 * carries no snapshot. Throws on anything else that is not a JSON array: the
 * caller treats that as corruption.
 */
export function parseShellSnapshot(
  bytes: Uint8Array,
): ShellSnapshotRecord[] | undefined {
  if (bytes.length === 0) return undefined;
  const parsed: unknown = JSON.parse(textDecoder.decode(bytes));
  if (!Array.isArray(parsed)) {
    throw new Error("shell snapshot is not an array");
  }
  return parsed as ShellSnapshotRecord[];
}

/**
 * Incremental reader over a streamed frame (a Cache API response body or a KV
 * `{ type: "stream" }` value). The serve path reads the head and exactly the
 * prelude's bytes before it commits; the snapshot is whatever remains.
 */
export class ShellFrameReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private done = false;

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader();
  }

  /** Exactly `n` bytes, or null when the stream ends first. */
  async take(n: number): Promise<Uint8Array | null> {
    while (this.buffered < n && !this.done) {
      const { done, value } = await this.reader.read();
      if (done) {
        this.done = true;
      } else if (value.length > 0) {
        this.chunks.push(value);
        this.buffered += value.length;
      }
    }
    if (this.buffered < n) return null;
    const out = concat(this.chunks, n);
    const leftover = this.buffered - n;
    const last = this.chunks[this.chunks.length - 1]!;
    this.chunks = leftover > 0 ? [last.subarray(last.length - leftover)] : [];
    this.buffered = leftover;
    return out;
  }

  /** The head, or null when the magic, length, or JSON is malformed or short. */
  async readHead(): Promise<ShellFrameHead | null> {
    const prefix = await this.take(PREFIX_BYTES);
    if (!prefix || MAGIC.some((byte, index) => prefix[index] !== byte)) {
      return null;
    }
    const lengthDigits = textDecoder.decode(prefix.subarray(MAGIC.length));
    if (!/^[0-9a-f]{8}$/.test(lengthDigits)) return null;
    const headBytes = await this.take(Number.parseInt(lengthDigits, 16));
    if (!headBytes) return null;
    let head: unknown;
    try {
      head = JSON.parse(textDecoder.decode(headBytes));
    } catch {
      return null;
    }
    return isShellFrameHead(head) ? head : null;
  }

  /** Everything after what was taken, to the end of the stream. */
  async readRest(): Promise<Uint8Array> {
    while (!this.done) {
      const { done, value } = await this.reader.read();
      if (done) {
        this.done = true;
      } else if (value.length > 0) {
        this.chunks.push(value);
        this.buffered += value.length;
      }
    }
    const out = concat(this.chunks, this.buffered);
    this.chunks = [];
    this.buffered = 0;
    return out;
  }

  /** Stop reading and release the body. */
  cancel(): void {
    this.done = true;
    this.reader.cancel().catch(() => {});
  }
}

/** The first `n` bytes of `chunks` as one array (no copy for a single chunk). */
function concat(chunks: Uint8Array[], n: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]!.length === n) return chunks[0]!;
  const out = new Uint8Array(n);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= n) break;
    const part = chunk.subarray(0, Math.min(chunk.length, n - offset));
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
