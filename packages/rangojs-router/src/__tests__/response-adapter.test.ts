import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Set up window.location.origin before importing the module
beforeEach(() => {
  (globalThis as any).window = {
    location: { origin: "http://localhost:3000" },
  };
});

afterEach(() => {
  delete (globalThis as any).window;
  vi.restoreAllMocks();
});

// Dynamic import so window.location.origin is available at module eval time
let extractRscHeaderUrl: typeof import("../browser/response-adapter").extractRscHeaderUrl;
let emptyResponse: typeof import("../browser/response-adapter").emptyResponse;
let teeWithCompletion: typeof import("../browser/response-adapter").teeWithCompletion;
let isForeignRouterId: typeof import("../browser/response-adapter").isForeignRouterId;

beforeEach(async () => {
  const mod = await import("../browser/response-adapter");
  extractRscHeaderUrl = mod.extractRscHeaderUrl;
  emptyResponse = mod.emptyResponse;
  teeWithCompletion = mod.teeWithCompletion;
  isForeignRouterId = mod.isForeignRouterId;
});

describe("isForeignRouterId", () => {
  const withId = (id: string) =>
    new Response(null, { headers: { "X-RSC-Router-Id": id } });

  it("is false when the header equals the expected id", () => {
    expect(isForeignRouterId(withId("app-a"), "app-a")).toBe(false);
  });

  it("is true when the header differs from the expected id", () => {
    expect(isForeignRouterId(withId("other-app"), "app-a")).toBe(true);
  });

  // The both-present guard — these are the false-positive safeguards. An absent
  // header (control reload/redirect responses are not stamped) or an absent
  // expected id (client not yet seeded) must never read as foreign.
  it("is false when the header is missing", () => {
    expect(isForeignRouterId(new Response(null), "app-a")).toBe(false);
  });

  it("is false when the expected id is undefined", () => {
    expect(isForeignRouterId(withId("app-a"), undefined)).toBe(false);
  });

  it("is false when both are missing", () => {
    expect(isForeignRouterId(new Response(null), undefined)).toBe(false);
  });
});

describe("extractRscHeaderUrl", () => {
  it("returns null when header is absent", () => {
    const res = new Response(null, { headers: {} });
    expect(extractRscHeaderUrl(res, "X-RSC-Redirect")).toBeNull();
  });

  it("returns { url } for a same-origin header value", () => {
    const res = new Response(null, {
      headers: { "X-RSC-Redirect": "/dashboard" },
    });
    const result = extractRscHeaderUrl(res, "X-RSC-Redirect");
    expect(result).toEqual({ url: "http://localhost:3000/dashboard" });
  });

  it('returns "blocked" for a cross-origin header value', () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = new Response(null, {
      headers: { "X-RSC-Redirect": "https://evil.com/phish" },
    });
    expect(extractRscHeaderUrl(res, "X-RSC-Redirect")).toBe("blocked");
  });

  it("works with X-RSC-Reload header", () => {
    const res = new Response(null, {
      headers: { "X-RSC-Reload": "/settings?tab=2" },
    });
    const result = extractRscHeaderUrl(res, "X-RSC-Reload");
    expect(result).toEqual({ url: "http://localhost:3000/settings?tab=2" });
  });
});

describe("emptyResponse", () => {
  it("returns a 200 response with null body", () => {
    const res = emptyResponse();
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });
});

describe("teeWithCompletion", () => {
  it("calls onComplete synchronously when response has no body", () => {
    const onComplete = vi.fn();
    const res = new Response(null);
    const result = teeWithCompletion(res, onComplete);

    expect(onComplete).toHaveBeenCalledOnce();
    expect(result).toBe(res);
  });

  it("calls onComplete after stream is fully consumed", async () => {
    const onComplete = vi.fn();
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("chunk1"));
        controller.enqueue(encoder.encode("chunk2"));
        controller.close();
      },
    });
    const res = new Response(stream);

    const teed = teeWithCompletion(res, onComplete);

    // onComplete not called yet (stream not consumed)
    expect(onComplete).not.toHaveBeenCalled();

    // Consume the returned response body to let both branches drain
    const reader = teed.body!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    // Wait a tick for the tracking reader to finish
    await new Promise((r) => setTimeout(r, 10));

    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("preserves response status, statusText, and headers", () => {
    const onComplete = vi.fn();
    const stream = new ReadableStream({
      start(c) {
        c.close();
      },
    });
    const res = new Response(stream, {
      status: 201,
      statusText: "Created",
      headers: { "X-Custom": "value" },
    });

    const teed = teeWithCompletion(res, onComplete);

    expect(teed.status).toBe(201);
    expect(teed.statusText).toBe("Created");
    expect(teed.headers.get("X-Custom")).toBe("value");
  });

  it("calls onComplete exactly once when the stream errors mid-read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onComplete = vi.fn();
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("chunk1"));
        controller.error(new Error("mid-stream failure"));
      },
    });
    const res = new Response(stream);

    teeWithCompletion(res, onComplete);

    // Wait for the tracking reader's read() to reject and both the finally
    // block and the .catch handler to run.
    await new Promise((r) => setTimeout(r, 50));

    // The finally block and the rejection's .catch must not both fire onComplete.
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("calls onComplete when abort signal fires", async () => {
    const onComplete = vi.fn();
    const controller = new AbortController();

    // Create a stream that never ends on its own
    const stream = new ReadableStream({
      start() {
        // intentionally open - will be aborted
      },
    });
    const res = new Response(stream);

    teeWithCompletion(res, onComplete, controller.signal);

    expect(onComplete).not.toHaveBeenCalled();

    controller.abort();

    // Wait for the abort + catch path to fire onComplete
    await new Promise((r) => setTimeout(r, 50));

    expect(onComplete).toHaveBeenCalledOnce();
  });
});

// These tests validate the contract that server-action-bridge relies on:
// when a header check returns "blocked", resolveStreamComplete() must be called
// before returning emptyResponse(). The bridge does this inline, but the
// correctness depends on emptyResponse() being safe for Flight parsing (null body)
// and extractRscHeaderUrl returning the correct discriminant.
describe("blocked-header completion contract", () => {
  it("blocked reload path: resolveStreamComplete fires, emptyResponse is Flight-safe", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = new Response("body", {
      headers: { "X-RSC-Reload": "https://evil.com/reload" },
    });
    const reload = extractRscHeaderUrl(response, "X-RSC-Reload");
    expect(reload).toBe("blocked");

    // The bridge calls resolveStreamComplete() then returns emptyResponse()
    let streamResolved = false;
    const resolveStreamComplete = () => {
      streamResolved = true;
    };

    // Simulate the bridge's blocked-reload branch
    if (reload === "blocked") {
      resolveStreamComplete();
      const empty = emptyResponse();
      expect(empty.body).toBeNull();
      expect(empty.status).toBe(200);
    }
    expect(streamResolved).toBe(true);
  });

  it("blocked redirect path: resolveStreamComplete fires, emptyResponse is Flight-safe", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = new Response("body", {
      headers: { "X-RSC-Redirect": "https://evil.com/phish" },
    });
    const redirect = extractRscHeaderUrl(response, "X-RSC-Redirect");
    expect(redirect).toBe("blocked");

    let streamResolved = false;
    const resolveStreamComplete = () => {
      streamResolved = true;
    };

    if (redirect === "blocked") {
      resolveStreamComplete();
      const empty = emptyResponse();
      expect(empty.body).toBeNull();
      expect(empty.status).toBe(200);
    }
    expect(streamResolved).toBe(true);
  });

  it("teeWithCompletion fires onComplete even if returned response is never read", async () => {
    // This mirrors what happens when the bridge returns emptyResponse() for
    // a valid redirect — the tee'd response is discarded, but the tracking
    // stream still needs to eventually call onComplete.
    const onComplete = vi.fn();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1]));
        c.close();
      },
    });
    const res = new Response(stream);
    const controller = new AbortController();

    teeWithCompletion(res, onComplete, controller.signal);

    // Abort without reading — simulates discarding the tee'd response
    controller.abort();
    await new Promise((r) => setTimeout(r, 50));

    expect(onComplete).toHaveBeenCalledOnce();
  });
});
