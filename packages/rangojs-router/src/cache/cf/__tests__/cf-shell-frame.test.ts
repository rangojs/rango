import { describe, it, expect } from "vitest";
import {
  ShellFrameReader,
  encodeShellFrame,
  encodeShellSnapshot,
  parseShellSnapshot,
  shellFrameToText,
  type ShellFrameHead,
} from "../cf-shell-frame";
import type { ShellSnapshotRecord } from "../../types";

const encoder = new TextEncoder();

function head(overrides: Partial<ShellFrameHead> = {}): ShellFrameHead {
  return {
    rv: "19.2.6",
    bv: "build-abc",
    c: 1,
    s: 2,
    e: 3,
    po: null,
    pl: 0,
    sl: 0,
    ...overrides,
  };
}

/** A body that delivers `bytes` in chunks of `size` bytes. */
function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

function bytesOf(text: string): Uint8Array {
  return encoder.encode(text);
}

/** The frame prefix ("RSH1" + 8 hex digits) with a given length field. */
function prefix(lengthField: string): Uint8Array {
  return bytesOf(`RSH1${lengthField}`);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe("cf-shell-frame", () => {
  // Non-ASCII in every part: the byte counts are UTF-8 bytes, not UTF-16
  // code units, on both the write and the read side.
  const prelude = bytesOf("<html><body>Grüße, 日本語 — shell</body></html>");
  const records: ShellSnapshotRecord[] = [
    {
      family: "loader",
      key: "M0L0D0.ключ",
      value: { value: "Größe 日本", holes: 0, runs: 0 },
    },
  ];
  const snapshot = encodeShellSnapshot(records)!;
  const frameHead = head({
    t: ["tag-ü"],
    dk: "doc:host/страница",
    pl: prelude.length,
    sl: snapshot.length,
  });
  const frame = encodeShellFrame(frameHead, prelude, snapshot);

  for (const size of [1, 7, 64, frame.length]) {
    it(`round-trips a non-ASCII frame delivered in ${size}-byte chunks`, async () => {
      const reader = new ShellFrameReader(chunked(frame, size));
      expect(await reader.readHead()).toEqual(frameHead);
      expect(await reader.take(frameHead.pl)).toEqual(prelude);
      const rest = await reader.readRest();
      expect(rest.length).toBe(frameHead.sl);
      expect(parseShellSnapshot(rest)).toEqual(records);
    });
  }

  it("round-trips through the KV string form", async () => {
    const text = shellFrameToText(frame);
    const reader = new ShellFrameReader(new Response(text).body!);
    expect(await reader.readHead()).toEqual(frameHead);
    expect(await reader.take(frameHead.pl)).toEqual(prelude);
    expect(parseShellSnapshot(await reader.readRest())).toEqual(records);
  });

  it("rejects a bad magic", async () => {
    const bad = frame.slice();
    bad[3] = 0x32; // "RSH2"
    const reader = new ShellFrameReader(chunked(bad, 5));
    expect(await reader.readHead()).toBeNull();
  });

  it("rejects a head length that is not 8 lowercase hex digits", async () => {
    for (const field of ["0000001G", "0000001A", "  00001a", "1a"]) {
      const body = concat(prefix(field), bytesOf("{}".padEnd(64, " ")));
      const reader = new ShellFrameReader(chunked(body, 3));
      expect(await reader.readHead()).toBeNull();
    }
  });

  it("rejects a head length longer than the body", async () => {
    const json = bytesOf(JSON.stringify(frameHead));
    const body = concat(prefix("7fffffff"), json);
    const reader = new ShellFrameReader(chunked(body, 16));
    expect(await reader.readHead()).toBeNull();
  });

  it("rejects a head that is not JSON, or fails validation", async () => {
    const notJson = bytesOf("{not json");
    const noSl = bytesOf(
      JSON.stringify({ ...frameHead, sl: undefined, pl: prelude.length }),
    );
    for (const json of [notJson, noSl]) {
      const length = json.length.toString(16).padStart(8, "0");
      const reader = new ShellFrameReader(
        chunked(concat(prefix(length), json), 4),
      );
      expect(await reader.readHead()).toBeNull();
    }
  });

  it("returns null when the body ends inside the prelude", async () => {
    const cut = frame.subarray(0, frame.length - snapshot.length - 3);
    const reader = new ShellFrameReader(chunked(cut, 9));
    expect(await reader.readHead()).toEqual(frameHead);
    expect(await reader.take(frameHead.pl)).toBeNull();
  });

  it("refuses to encode a head whose lengths do not match its parts", () => {
    expect(() =>
      encodeShellFrame({ ...frameHead, pl: prelude.length + 1 }, prelude),
    ).toThrow(/does not match/);
    expect(() =>
      encodeShellFrame({ ...frameHead, sl: 0 }, prelude, snapshot),
    ).toThrow(/does not match/);
  });

  it("refuses a KV string form for a prelude that is not UTF-8", () => {
    const binary = new Uint8Array([0xff, 0xfe, 0x00]);
    const binaryFrame = encodeShellFrame(head({ pl: binary.length }), binary);
    expect(() => shellFrameToText(binaryFrame)).toThrow();
  });
});
