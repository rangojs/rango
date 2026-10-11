// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitDocumentRevealed } from "../browser/document-revealed.js";

function marker(data: string, parent: Node = document.body): Comment {
  const node = document.createComment(data);
  parent.appendChild(node);
  return node;
}

/** Resolution state after letting queued microtasks run. */
async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false;
  void promise.then(() => (done = true));
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

function setReadyState(state: DocumentReadyState): void {
  Object.defineProperty(document, "readyState", {
    configurable: true,
    get: () => state,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  // A hidden tab never runs rAF: the poll must not depend on it.
  vi.stubGlobal("requestAnimationFrame", () => 0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (document as { readyState?: unknown }).readyState;
  document.body.replaceChildren();
});

describe("awaitDocumentRevealed", () => {
  it("resolves at once when no boundary is pending", async () => {
    expect(await settled(awaitDocumentRevealed())).toBe(true);
  });

  it.each(["$?", "$~"])(
    "waits while a %s boundary is in the document, resolves when it is revealed",
    async (pendingData) => {
      const boundary = marker(pendingData);
      const promise = awaitDocumentRevealed();
      expect(await settled(promise)).toBe(false);

      await vi.advanceTimersByTimeAsync(200);
      expect(await settled(promise)).toBe(false);

      boundary.data = "$";
      await vi.advanceTimersByTimeAsync(60);
      await expect(promise).resolves.toBeUndefined();
    },
  );

  it("resolves when React removes the pending boundary node", async () => {
    const boundary = marker("$?");
    const promise = awaitDocumentRevealed();
    boundary.remove();
    await vi.advanceTimersByTimeAsync(60);
    await expect(promise).resolves.toBeUndefined();
  });

  it("waits for DOMContentLoaded, then checks boundaries", async () => {
    setReadyState("loading");
    const boundary = marker("$?");
    const promise = awaitDocumentRevealed();
    boundary.data = "$";
    await vi.advanceTimersByTimeAsync(200);
    expect(await settled(promise)).toBe(false);

    setReadyState("interactive");
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await expect(promise).resolves.toBeUndefined();
  });

  it("keeps waiting for a boundary nested in content that joins the document only after its parent is revealed", async () => {
    const parent = marker("$?");
    const promise = awaitDocumentRevealed();
    expect(await settled(promise)).toBe(false);

    // The parent's reveal inserts content holding a still-pending boundary.
    parent.data = "$";
    const nested = marker(
      "$?",
      document.body.appendChild(document.createElement("div")),
    );
    await vi.advanceTimersByTimeAsync(60);
    expect(await settled(promise)).toBe(false);

    nested.data = "$";
    await vi.advanceTimersByTimeAsync(60);
    await expect(promise).resolves.toBeUndefined();
  });

  // A tab hidden after its first paint: React already revealed the boundary
  // (data flipped by hand here); rAF stops, the poll must still settle. A tab
  // hidden from load never gets the reveal, so this does not cover it.
  it("a tab hidden after first paint resolves with requestAnimationFrame never firing", async () => {
    const raf = vi.fn(() => 0);
    vi.stubGlobal("requestAnimationFrame", raf);
    const boundary = marker("$~");
    const promise = awaitDocumentRevealed();
    boundary.data = "$";
    await vi.advanceTimersByTimeAsync(60);
    await expect(promise).resolves.toBeUndefined();
    expect(raf).not.toHaveBeenCalled();
  });
});
