import { describe, it, expect, vi } from "vitest";
import { applyStreamIdleTimeout, type StreamIdleTrip } from "../stream-idle.js";
import { RouterTimeoutError } from "../../router/timeout.js";

const enc = (s: string) => new TextEncoder().encode(s);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeSource() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancelSpy = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel(reason) {
      cancelSpy(reason);
    },
  });
  return { stream, controller: () => controller, cancelSpy };
}

function wrap(stream: ReadableStream<Uint8Array>, idleMs: number) {
  const trips: StreamIdleTrip[] = [];
  const response = applyStreamIdleTimeout(
    new Response(stream, {
      status: 201,
      headers: { "x-test": "yes" },
    }),
    idleMs,
    (t) => trips.push(t),
  );
  return { response, trips };
}

describe("applyStreamIdleTimeout", () => {
  it("returns the response unchanged when there is no body", () => {
    const res = new Response(null, { status: 204 });
    const out = applyStreamIdleTimeout(res, 50, () => {});
    expect(out).toBe(res);
  });

  it("preserves status and headers on the wrapped response", () => {
    const { stream } = makeSource();
    const { response } = wrap(stream, 1000);
    expect(response.status).toBe(201);
    expect(response.headers.get("x-test")).toBe("yes");
  });

  it("forwards chunks (re-arming each time) and never trips on a stream that keeps flowing", async () => {
    const { stream, controller } = makeSource();
    const { response, trips } = wrap(stream, 60);
    const reader = response.body!.getReader();

    controller().enqueue(enc("a"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("a");
    await sleep(40); // inside the budget
    controller().enqueue(enc("b"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("b");
    await sleep(40); // re-armed by "b" — still inside
    controller().enqueue(enc("c"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("c");
    controller().close();
    expect((await reader.read()).done).toBe(true);
    expect(trips).toHaveLength(0);
  });

  it("trips on idle: errors the client stream, cancels the source, reports once", async () => {
    const { stream, controller, cancelSpy } = makeSource();
    const { response, trips } = wrap(stream, 30);
    const reader = response.body!.getReader();

    controller().enqueue(enc("shell"));
    await reader.read();

    // Producer wedges: nothing flows past the budget.
    let error: unknown;
    try {
      await reader.read();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RouterTimeoutError);
    expect((error as RouterTimeoutError).phase).toBe("stream-idle");

    expect(trips).toHaveLength(1);
    expect(trips[0].chunks).toBe(1);
    expect(trips[0].error).toBe(error);

    // The pipe cancels the wedged source so React tears the render down.
    await sleep(10);
    expect(cancelSpy).toHaveBeenCalledTimes(1);

    // No double-report after the trip.
    await sleep(80);
    expect(trips).toHaveLength(1);
  });

  it("does not trip after the source closed naturally", async () => {
    const { stream, controller } = makeSource();
    const { response, trips } = wrap(stream, 30);
    const reader = response.body!.getReader();

    controller().enqueue(enc("all"));
    controller().close();
    await reader.read();
    expect((await reader.read()).done).toBe(true);

    await sleep(90);
    expect(trips).toHaveLength(0);
  });

  it("teed source: the client branch is bounded, but the source stays alive for the cache branch", async () => {
    // Pins the documented limitation: when an upstream layer (document-cache
    // MISS drain) teed the body before the watchdog wrapped one branch,
    // erroring that branch does NOT cancel the underlying source — tee
    // semantics require every branch to cancel. The wedged render then lives
    // until the platform's waitUntil budget, as it did before this feature.
    const { stream, controller, cancelSpy } = makeSource();
    const [cacheBranch, clientBranch] = stream.tee();
    const trips: StreamIdleTrip[] = [];
    const response = applyStreamIdleTimeout(
      new Response(clientBranch, { status: 200 }),
      30,
      (t) => trips.push(t),
    );
    const reader = response.body!.getReader();
    const cacheReader = cacheBranch.getReader();

    controller().enqueue(enc("shell"));
    await reader.read();
    await cacheReader.read();

    let error: unknown;
    try {
      await reader.read();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RouterTimeoutError);
    expect(trips).toHaveLength(1);

    // The client branch is dead — but the SOURCE was not canceled: the cache
    // branch still holds it open.
    await sleep(20);
    expect(cancelSpy).not.toHaveBeenCalled();

    // Only when the cache branch also cancels does the source get torn down.
    await cacheReader.cancel("cache drain abandoned");
    await sleep(10);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it("does not report a trip after the CLIENT canceled the stream", async () => {
    const { stream, controller, cancelSpy } = makeSource();
    const { response, trips } = wrap(stream, 30);
    const reader = response.body!.getReader();

    controller().enqueue(enc("shell"));
    await reader.read();
    await reader.cancel("client went away");

    await sleep(90);
    // Cancellation is not a timeout: nothing to report, source torn down.
    expect(trips).toHaveLength(0);
    expect(cancelSpy).toHaveBeenCalled();
  });
});
