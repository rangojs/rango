import { describe, it, expect } from "vitest";
import { injectRSCPayloadEager } from "../inject-rsc-eager.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function streamFrom(
  chunks: (string | Uint8Array)[],
  opts?: { holdOpen?: boolean },
): {
  stream: ReadableStream<Uint8Array>;
  close: () => void;
  push: (c: string) => void;
} {
  let controllerRef: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      for (const c of chunks) {
        controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
      }
      if (!opts?.holdOpen) controller.close();
    },
  });
  return {
    stream,
    close: () => controllerRef.close(),
    push: (c: string) => controllerRef.enqueue(enc.encode(c)),
  };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

// The regression this injector exists for: Flight chunks must reach the output
// BEFORE any HTML arrives. The stock rsc-html-stream injector only starts
// forwarding Flight from its first transform() call, so a fizz stream that is
// stalled (PPR resume waiting on live loaders) parks the whole payload.
describe("injectRSCPayloadEager", () => {
  it("emits flight scripts while the HTML side is still silent", async () => {
    const rsc = streamFrom(['1:"root-row"\n']);
    // HTML source that never emits a chunk until we close it (stalled fizz).
    const html = streamFrom([], { holdOpen: true });

    const out = html.stream.pipeThrough(injectRSCPayloadEager(rsc.stream));
    const reader = out.getReader();

    // First output chunk must be the flight script — before any HTML exists.
    const first = await reader.read();
    expect(dec.decode(first.value)).toContain("__FLIGHT_DATA");
    expect(dec.decode(first.value)).toContain("root-row");

    html.close();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += dec.decode(value, { stream: true });
    }
    expect(rest).toBe("</body></html>");
  });

  it("passes HTML through, strips the trailer, and re-appends it once at the end", async () => {
    const rsc = streamFrom(['2:"data"\n']);
    const html = streamFrom(["<div>hole content</div></body></html>"]);
    const result = await drain(
      html.stream.pipeThrough(injectRSCPayloadEager(rsc.stream)),
    );
    expect(result).toContain("<div>hole content</div>");
    expect(result).toContain("__FLIGHT_DATA");
    // Exactly one trailer, at the very end.
    expect(result.endsWith("</body></html>")).toBe(true);
    expect(result.indexOf("</body></html>")).toBe(
      result.lastIndexOf("</body></html>"),
    );
  });

  it("never lands a flight script between same-tick HTML chunks", async () => {
    // Two synchronously-enqueued fizz chunks that split one logical tag write.
    const html = streamFrom(["<div", ' data-x="1">ok</div>']);
    const rsc = streamFrom(['3:"row"\n']);
    const result = await drain(
      html.stream.pipeThrough(injectRSCPayloadEager(rsc.stream)),
    );
    // The split tag must have been reassembled contiguously.
    expect(result).toContain('<div data-x="1">ok</div>');
  });

  it("escapes closing script tags in flight content", async () => {
    const rsc = streamFrom(['4:"</script><b>x</b>"\n']);
    const html = streamFrom(["<p>hi</p>"]);
    const result = await drain(
      html.stream.pipeThrough(injectRSCPayloadEager(rsc.stream)),
    );
    expect(result).not.toContain('</script><b>x</b>"');
    expect(result).toContain("</\\script");
  });

  it("carries the nonce onto every flight script tag", async () => {
    const rsc = streamFrom(['5:"a"\n', '6:"b"\n']);
    const html = streamFrom(["<p>x</p>"]);
    const result = await drain(
      html.stream.pipeThrough(
        injectRSCPayloadEager(rsc.stream, { nonce: "abc123" }),
      ),
    );
    const scripts = result.match(/<script nonce="abc123">/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    expect(result.match(/<script>/g)).toBeNull();
  });

  it("does not deadlock on a chunkless HTML source (DATA variant)", async () => {
    const rsc = streamFrom(['7:"payload"\n']);
    const html = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const result = await drain(
      html.pipeThrough(injectRSCPayloadEager(rsc.stream)),
    );
    expect(result).toContain("payload");
    expect(result.endsWith("</body></html>")).toBe(true);
  });

  it("falls back to base64 for invalid-unicode flight chunks", async () => {
    // Lone continuation byte — TextDecoder({fatal:true}) throws on it.
    const rsc = streamFrom([new Uint8Array([0x80, 0x81])]);
    const html = streamFrom(["<p>x</p>"]);
    const result = await drain(
      html.stream.pipeThrough(injectRSCPayloadEager(rsc.stream)),
    );
    expect(result).toContain("Uint8Array.from(atob(");
  });
});
