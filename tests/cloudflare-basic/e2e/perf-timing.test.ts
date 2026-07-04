import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

/**
 * End-to-end coverage for debugPerformance's Server-Timing header through a
 * real workerd/Vite pipeline (middleware merge, response finalization).
 *
 * The router does NOT enable debugPerformance globally (that would spam
 * [RSC Perf] logs across the whole suite). Instead src/router.tsx registers a
 * per-request opt-in middleware: ?__perf_debug=1 calls ctx.debugPerformance()
 * BEFORE next(), creating the metrics store mid-request so downstream phases
 * (match/render/ssr) record into it. This is the documented consumer pattern
 * (packages/rangojs-router/docs/telemetry.md "Per-request opt-in").
 *
 * Header names are the folded Server-Timing forms: metrics.ts generateServerTiming
 * lowercases and maps ":" -> "-" and drops other non-[a-zA-Z0-9-] chars, so
 * `handler:total` -> `handler-total`, `ssr:render-html` -> `ssr-render-html`,
 * `render:total:blog` -> `render-total-blog`.
 *
 * Runs in BOTH dev and production so the header's journey through middleware
 * merge and response finalization is verified in a real workerd runtime each mode.
 */

function runPerfSpec(f: Fixture): void {
  test("opt-in produces the full metrics timeline in Server-Timing", async ({
    page,
  }) => {
    // accept: text/html forces the full-page SSR branch (a bare fetch would take
    // the RSC-payload path). /blog renders SSR, so match/render/ssr phases run
    // and record into the mid-request store created by ctx.debugPerformance().
    const res = await page.request.get(f.url("/blog?__perf_debug=1"), {
      headers: { accept: "text/html" },
    });
    expect(res.status()).toBe(200);

    const timing = res.headers()["server-timing"];
    expect(
      timing,
      "Server-Timing missing — is the __perf_debug opt-in wired and the store created?",
    ).toBeTruthy();

    // handler:total is appended only when a metrics store exists (folded form).
    expect(timing).toContain("handler-total;dur=");

    // At least one render-phase metric proves the mid-request store captured
    // downstream phases, not just the always-on bootstrap entries.
    const hasRenderPhase =
      timing!.includes("render-total") || timing!.includes("ssr-render-html");
    expect(
      hasRenderPhase,
      `expected render-total or ssr-render-html in Server-Timing, got: ${timing}`,
    ).toBe(true);

    // handler:total is the full request duration — must be a real positive number.
    const match = timing!.match(/handler-total;dur=([\d.]+)/);
    expect(match, "handler-total must carry a dur= value").toBeTruthy();
    expect(Number.parseFloat(match![1])).toBeGreaterThan(0);
  });

  test("bootstrap entries emit without the opt-in but handler-total does not", async ({
    page,
  }) => {
    // No __perf_debug: no metrics store is created, so handler:total is absent.
    // Bootstrap handler phases are unconditional, so the header still exists.
    const res = await page.request.get(f.url("/blog"), {
      headers: { accept: "text/html" },
    });
    expect(res.status()).toBe(200);

    const timing = res.headers()["server-timing"];
    expect(
      timing,
      "Server-Timing missing — bootstrap entries are always emitted",
    ).toBeTruthy();
    expect(timing).toContain("handler-nonce;dur=");
    expect(timing).not.toContain("handler-total");
  });

  test("the debug store does not leak into the next request", async ({
    page,
  }) => {
    // The store is created for the debug request only. A subsequent plain
    // request must NOT inherit handler:total — pins per-request isolation
    // (docs/telemetry.md: "created for that request only").
    const debugRes = await page.request.get(f.url("/blog?__perf_debug=1"), {
      headers: { accept: "text/html" },
    });
    expect(debugRes.status()).toBe(200);
    expect(debugRes.headers()["server-timing"]).toContain("handler-total;dur=");

    const plainRes = await page.request.get(f.url("/blog"), {
      headers: { accept: "text/html" },
    });
    expect(plainRes.status()).toBe(200);
    expect(plainRes.headers()["server-timing"]).not.toContain("handler-total");
  });
}

test.describe("debugPerformance Server-Timing (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runPerfSpec(f);
});

test.describe("debugPerformance Server-Timing (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runPerfSpec(f);
});
