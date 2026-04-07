// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForViewportImages } from "../browser/prefetch/resource-ready";

function createMockImage(opts: {
  complete: boolean;
  inViewport: boolean;
}): HTMLImageElement {
  const listeners: Record<string, Array<() => void>> = {};
  const img = {
    complete: opts.complete,
    getBoundingClientRect: () =>
      opts.inViewport
        ? { top: 0, right: 100, bottom: 100, left: 0 }
        : { top: -200, right: 100, bottom: -100, left: 0 },
    addEventListener: (
      event: string,
      handler: () => void,
      _opts?: { once: boolean },
    ) => {
      (listeners[event] ??= []).push(handler);
    },
  } as unknown as HTMLImageElement;
  (img as any).__fire = (event: string) => {
    const fns = listeners[event] ?? [];
    for (const fn of fns) fn();
  };
  return img;
}

describe("waitForViewportImages", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves immediately when no images exist", async () => {
    vi.spyOn(document, "querySelectorAll").mockReturnValue(
      [] as unknown as NodeListOf<HTMLImageElement>,
    );
    await waitForViewportImages();
  });

  it("resolves immediately when all images are complete", async () => {
    const img = createMockImage({ complete: true, inViewport: true });
    vi.spyOn(document, "querySelectorAll").mockReturnValue([
      img,
    ] as unknown as NodeListOf<HTMLImageElement>);
    await waitForViewportImages();
  });

  it("ignores images outside the viewport", async () => {
    const img = createMockImage({ complete: false, inViewport: false });
    vi.spyOn(document, "querySelectorAll").mockReturnValue([
      img,
    ] as unknown as NodeListOf<HTMLImageElement>);
    // Should resolve immediately — offscreen image is filtered out
    await waitForViewportImages();
  });

  it("waits for pending viewport images to load", async () => {
    const img = createMockImage({ complete: false, inViewport: true });
    vi.spyOn(document, "querySelectorAll").mockReturnValue([
      img,
    ] as unknown as NodeListOf<HTMLImageElement>);

    let resolved = false;
    const p = waitForViewportImages().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    // Simulate load
    (img as any).__fire("load");
    await p;
    expect(resolved).toBe(true);
  });

  it("resolves on error too", async () => {
    const img = createMockImage({ complete: false, inViewport: true });
    vi.spyOn(document, "querySelectorAll").mockReturnValue([
      img,
    ] as unknown as NodeListOf<HTMLImageElement>);

    let resolved = false;
    const p = waitForViewportImages().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    (img as any).__fire("error");
    await p;
    expect(resolved).toBe(true);
  });

  it("does not double-count when img.complete flips during setup and load event fires", async () => {
    // imgA completes during addEventListener — simulates the race where
    // the image finishes between the initial filter and listener attachment.
    // addEventListener flips complete=true and queues a microtask load event.
    const imgA = createMockImage({ complete: false, inViewport: true });
    const origAddEventListener = imgA.addEventListener.bind(imgA);
    let fireLoadAsync: (() => void) | null = null;
    imgA.addEventListener = ((
      event: string,
      handler: () => void,
      opts?: { once: boolean },
    ) => {
      origAddEventListener(event, handler, opts);
      // On first "load" listener, flip complete and schedule the event
      if (event === "load" && !fireLoadAsync) {
        (imgA as any).complete = true;
        fireLoadAsync = () => (imgA as any).__fire("load");
      }
    }) as any;

    const imgB = createMockImage({ complete: false, inViewport: true });

    vi.spyOn(document, "querySelectorAll").mockReturnValue([
      imgA,
      imgB,
    ] as unknown as NodeListOf<HTMLImageElement>);

    let resolved = false;
    // waitForViewportImages runs synchronously:
    // 1. Attaches listeners on imgA → complete flips true
    // 2. Attaches listeners on imgB
    // 3. Re-checks imgA.complete → true → settle(imgA) called
    // 4. Re-checks imgB.complete → false → no-op
    const p = waitForViewportImages().then(() => {
      resolved = true;
    });

    // Now fire the queued load event on imgA — settle(imgA) again (idempotent)
    fireLoadAsync!();

    await Promise.resolve();
    // imgB still pending — must NOT have resolved early
    expect(resolved).toBe(false);

    // imgB finishes
    (imgB as any).__fire("load");
    await p;
    expect(resolved).toBe(true);
  });

  it("handles multiple images finishing in any order", async () => {
    const imgs = [
      createMockImage({ complete: false, inViewport: true }),
      createMockImage({ complete: false, inViewport: true }),
      createMockImage({ complete: false, inViewport: true }),
    ];

    vi.spyOn(document, "querySelectorAll").mockReturnValue(
      imgs as unknown as NodeListOf<HTMLImageElement>,
    );

    let resolved = false;
    const p = waitForViewportImages().then(() => {
      resolved = true;
    });

    // Complete in reverse order
    (imgs[2] as any).__fire("load");
    await Promise.resolve();
    expect(resolved).toBe(false);

    (imgs[0] as any).__fire("error");
    await Promise.resolve();
    expect(resolved).toBe(false);

    (imgs[1] as any).__fire("load");
    await p;
    expect(resolved).toBe(true);
  });
});
