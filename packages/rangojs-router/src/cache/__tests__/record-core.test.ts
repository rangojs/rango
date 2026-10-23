/**
 * readRecord over a synchronous backend settles without an await: an expired
 * record is removed in the tick it was read. With an await between the read
 * and the removal, a write landing in between would be removed with it.
 * `record-read-sequence.test.ts` pins the per-outcome sequence; this pins the
 * timing the in-process maps rely on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import { readRecord, type RecordBackend } from "../record-core.js";

const T0 = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("readRecord over a synchronous backend", () => {
  it("removes an expired record before it returns its promise", () => {
    const removed: string[] = [];
    const backend: RecordBackend = {
      read: () => ({ expiresAt: T0 - 1 }),
      write: () => {},
      remove: (key) => {
        removed.push(key);
      },
    };
    void readRecord(
      backend,
      "k",
      {
        family: "item",
        debugOp: "getItem",
        label: "test",
        onReadError: "miss",
        decode: (raw) => raw as { expiresAt: number },
        meta: (record) => ({ staleAt: 0, expiresAt: record.expiresAt }),
      },
      {},
    );
    expect(removed).toEqual(["k"]);
  });

  it("keeps a memory store write issued right after the read of its expired entry", async () => {
    const store = new MemorySegmentCacheStore();
    await store.setItem("k", "v1", { ttl: 1, swr: 0 });
    vi.setSystemTime(T0 + 5_000);

    const expired = store.getItem("k");
    const write = store.setItem("k", "v2", { ttl: 60 });

    expect(await expired).toBeNull();
    await write;
    expect((await store.getItem("k"))?.value).toBe("v2");
  });
});
