import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";

/**
 * E2e for timeouts.streamIdleMs (the "stream-idle" phase): a streamed body
 * with a never-settling suspended subtree must be TERMINATED by the router's
 * idle watchdog instead of holding the connection open forever. The fixture
 * router (prefetch-scope-router.tsx) configures streamIdleMs: 2500 and serves
 * /__prefetch-scope/stream-hang, whose shell flushes and then wedges.
 *
 * The transport surfaces the server-side stream error either as a body read
 * error or as an abrupt end — the contract under test is TERMINATION WITHIN
 * THE BUDGET (this test hangs to its own timeout on a regression), the shell
 * having flushed, and the hung content never arriving.
 */

async function drainWithTiming(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const start = Date.now();
  let html = "";
  let error: unknown;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
    }
  } catch (e) {
    error = e;
  }
  return { html, error, elapsedMs: Date.now() - start };
}

function runStreamIdleSpec(f: ReturnType<typeof useFixture>): void {
  test("terminates a wedged stream within the idle budget", async () => {
    test.setTimeout(45_000);
    const res = await fetch(f.url("/__prefetch-scope/stream-hang"), {
      headers: { accept: "text/html" },
    });
    expect(res.status).toBe(200);

    // Clock starts AFTER headers (handoff): dev compile latency is excluded.
    const { html, error, elapsedMs } = await drainWithTiming(res);

    // The shell flushed with the fallback; the hung subtree never resolved.
    expect(html).toContain("hang-shell");
    expect(html).toContain("hang-fallback");

    // Terminated by the watchdog: within the 2.5s budget window (+ transport
    // slack), never held open indefinitely. Most transports surface the trip
    // as a read error; an abrupt clean end is also termination.
    expect(elapsedMs).toBeGreaterThanOrEqual(1_500);
    expect(elapsedMs).toBeLessThan(20_000);
    if (error !== undefined) {
      expect(String(error)).toMatch(/terminated|abort|error|closed/i);
    }
  });

  test("does not disturb a healthy fast stream on the same router", async () => {
    const res = await fetch(f.url("/__prefetch-scope/target"), {
      headers: { accept: "text/html" },
    });
    expect(res.status).toBe(200);
    const { html, error } = await drainWithTiming(res);
    expect(error).toBeUndefined();
    expect(html).toContain("Prefetch target");
    expect(html).toContain("</html>");
  });
}

test.describe("stream-idle timeout (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runStreamIdleSpec(f);
});

test.describe("stream-idle timeout (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runStreamIdleSpec(f);
});
