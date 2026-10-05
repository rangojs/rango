/**
 * The warm mark, the replace-mode predicate and the record's writers
 * (prerender/warm-request.ts). The layers that call them are tested where
 * they live; these pin the helpers' own contract.
 */
import { describe, expect, it } from "vitest";
import {
  createWarmRecord,
  isWarmReplace,
  markWarmRequest,
  noteWarmDocument,
  noteWarmIdentityRead,
  noteWarmShellEvent,
  noteWarmWrite,
  readWarmMark,
} from "../warm-request.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";

const cacheConfig = { store: new MemorySegmentCacheStore() };

describe("the warm mark", () => {
  it("is the Request object: a clone or a rebuilt request carries none", () => {
    const record = createWarmRecord("replace", cacheConfig);
    const request = new Request("https://shop.example/p");
    markWarmRequest(request, record);

    expect(readWarmMark(request)).toBe(record);
    expect(readWarmMark(request.clone())).toBeUndefined();
    expect(readWarmMark(new Request(request))).toBeUndefined();
    expect(
      readWarmMark(new Request(request.url, { headers: request.headers })),
    ).toBeUndefined();
  });

  it("cannot be set from the bytes of a request", () => {
    // Nothing a client sends makes a request a warm: the same URL and headers
    // on another Request object read no record.
    const marked = new Request("https://shop.example/p?x=1", {
      headers: { accept: "text/html", "x-rango-warm": "1" },
    });
    markWarmRequest(marked, createWarmRecord("replace", cacheConfig));
    const fromClient = new Request("https://shop.example/p?x=1", {
      headers: { accept: "text/html", "x-rango-warm": "1" },
    });

    expect(readWarmMark(fromClient)).toBeUndefined();
  });

  it("a new record starts with zero writes and nothing reported", () => {
    expect(createWarmRecord("fill", cacheConfig)).toEqual({
      mode: "fill",
      renderErrors: [],
      cacheConfig,
      writes: { record: 0, item: 0, response: 0, shell: 0 },
    });
  });
});

describe("isWarmReplace", () => {
  it("is true only for a replace-mode record", () => {
    expect(
      isWarmReplace({
        _prerenderWarm: createWarmRecord("replace", cacheConfig),
      }),
    ).toBe(true);
    expect(
      isWarmReplace({ _prerenderWarm: createWarmRecord("fill", cacheConfig) }),
    ).toBe(false);
    expect(isWarmReplace({})).toBe(false);
    expect(isWarmReplace(undefined)).toBe(false);
    expect(isWarmReplace(null)).toBe(false);
  });

  it("is false in the warm's own shell capture, which inherits the record", () => {
    const foreground = {
      _prerenderWarm: createWarmRecord("replace", cacheConfig),
    };
    // deriveShellCaptureContext: Object.create(reqCtx) plus the run flag.
    const capture = Object.create(foreground) as typeof foreground & {
      _shellCaptureRun?: boolean;
    };
    capture._shellCaptureRun = true;

    expect(capture._prerenderWarm).toBe(foreground._prerenderWarm);
    expect(isWarmReplace(capture)).toBe(false);
    expect(isWarmReplace(foreground)).toBe(true);
  });
});

describe("the record's writers", () => {
  it("noteWarmWrite counts by family, and through a derived context", () => {
    const record = createWarmRecord("replace", cacheConfig);
    const ctx = { _prerenderWarm: record };
    noteWarmWrite(ctx, "record");
    noteWarmWrite(ctx, "item");
    noteWarmWrite(ctx, "item");
    noteWarmWrite(Object.create(ctx), "shell");

    expect(record.writes).toEqual({
      record: 1,
      item: 2,
      response: 0,
      shell: 1,
    });
  });

  it("every writer is a no-op without a record", () => {
    expect(() => {
      noteWarmWrite({}, "record");
      noteWarmWrite(undefined, "item");
      noteWarmDocument({}, "stored");
      noteWarmDocument(null, "not-cacheable");
      noteWarmIdentityRead({}, "cookies()");
      noteWarmIdentityRead(undefined, "cookies()");
      noteWarmIdentityRead(null, "cookies()");
    }).not.toThrow();
  });

  it("noteWarmDocument records the outcome only; the write count is noteWarmWrite's", () => {
    const record = createWarmRecord("replace", cacheConfig);
    noteWarmDocument({ _prerenderWarm: record }, "not-cacheable");
    expect(record.document).toBe("not-cacheable");
    expect(record.writes.response).toBe(0);

    noteWarmDocument({ _prerenderWarm: record }, "stored");
    expect(record.document).toBe("stored");
    expect(record.writes.response).toBe(0);
  });

  it("noteWarmIdentityRead keeps the first refused surface", () => {
    const record = createWarmRecord("replace", cacheConfig);
    noteWarmIdentityRead({ _prerenderWarm: record }, "cookies()");
    noteWarmIdentityRead({ _prerenderWarm: record }, "headers()");

    expect(record.identity).toBe("cookies()");
  });
});

describe("noteWarmShellEvent", () => {
  const key = "shell:k";

  it("maps a capture attempt's outcome onto the record", () => {
    const cases = [
      ["stored", "stored"],
      ["refused", "refused"],
      ["no-shell", "no-shell"],
      ["expired", "no-shell"],
      ["redirect", "no-shell"],
      ["error", "error"],
      ["skip-capacity", "skipped-capacity"],
      ["skip-queue-timeout", "skipped-queue-timeout"],
      ["skip-inert-store", "not-eligible"],
    ] as const;
    for (const [outcome, shell] of cases) {
      const record = createWarmRecord("replace", cacheConfig);
      // captureAndStoreShell counts the write before the event is published.
      if (outcome === "stored") record.writes.shell = 1;
      noteWarmShellEvent(record, { key, outcome });
      expect(record.shell, outcome).toBe(shell);
    }
  });

  it("a stored attempt whose putShell counted no write is an error, not a stored shell", () => {
    // The store's put threw: the attempt still ends `stored` and the I/O
    // error is reported, but nothing a visitor can read was written.
    const record = createWarmRecord("replace", cacheConfig);
    noteWarmShellEvent(record, { key, outcome: "stored", attempt: 1 });

    expect(record.shell).toBe("error");
  });

  it("ignores the skips a forced capture never takes, and the backoff notice", () => {
    const record = createWarmRecord("fill", cacheConfig);
    record.shell = "fresh";
    for (const outcome of [
      "skip-in-flight",
      "skip-stored",
      "skip-backoff",
      "backoff",
    ] as const) {
      noteWarmShellEvent(record, { key, outcome });
    }

    expect(record.shell).toBe("fresh");
  });

  it("carries the refusal, and the last attempt stands", () => {
    const record = createWarmRecord("replace", cacheConfig);
    noteWarmShellEvent(record, {
      key,
      outcome: "refused",
      attempt: 1,
      refusal: "identity",
    });
    expect(record).toMatchObject({ shell: "refused", refusal: "identity" });

    // An in-place retry that stores clears the first attempt's refusal.
    noteWarmShellEvent(record, { key, outcome: "no-shell", attempt: 1 });
    record.writes.shell = 1;
    noteWarmShellEvent(record, { key, outcome: "stored", attempt: 2 });
    expect(record.shell).toBe("stored");
    expect(record.refusal).toBeUndefined();
  });
});
