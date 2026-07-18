import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";

// PPR capture-budget + nameless-route coverage (issues #714 / #715) against
// the KV-backed CFCacheStore on workerd, dev AND production:
//
// - /ppr-nameless/:probe — a NAMELESS ppr route (#714): `name` is orthogonal
//   to shell caching; the entry registers under a synthesized $path_* manifest
//   key with the ppr option intact and must engage MISS -> HIT like its named
//   siblings.
// - /ppr-slow-meta — deferred shell material settling IN PARTS (immediate
//   push, ~5.5s slow push, Meta title CHAINED off the slow promise +1s) with
//   `ppr.captureTimeout: 10000` (#715): the capture rides the COMPLETE
//   settlement sequence and bakes ALL resolved parts into the stored prelude.
// - /ppr-short-meta — ~3.5s material against an EXPLICIT 1500ms budget: the
//   budget expires with pushes pending, the capture REFUSES, the route stays
//   MISS and no partial-meta shell is ever stored. (Both refusal negatives —
//   here and the router test-app's slow-meta-default — use explicit
//   sub-settlement budgets: the 15s default ADMITS this material, and a
//   no-knob refusal would need >15s material and ~30s waits. The default
//   VALUE is pinned by the router's shell-capture unit test. The refusal
//   warning is asserted in the test-app suite, whose isolated server exposes
//   process logs; this suite's shared webServer exposes no log handle.)
//
// None of these routes are in dev-warmup's PPR_WARMUP_HIT_ROUTES — a ~6.5s
// capture must never park the shared warmup path; these tests own their full
// MISS -> capture -> HIT round-trips.

const HTML_HEADERS = { Accept: "text/html" };

// The slow fixture's live render awaits its pushes (~6.5s), so raise
// per-request ceilings; the capture needs settle + quiesce + KV put on top.
const SLOW_REQUEST_TIMEOUT_MS = 30_000;
const SLOW_HIT_POLL_TIMEOUT_MS = 60_000;
// Two short-budget attempts (1.5s + 400ms + 1.5s) plus margin: the window in
// which /ppr-short-meta's capture deterministically refuses.
const SHORT_BUDGET_REFUSAL_MS = 6_000;

interface SpanNode {
  name: string;
  attributes: Record<string, string | number | boolean>;
  children: SpanNode[];
}

function decodeTrace(value: string): SpanNode[] {
  const json = decodeURIComponent(escape(atob(value)));
  return JSON.parse(json) as SpanNode[];
}

function findSpan(nodes: SpanNode[], name: string): SpanNode | undefined {
  for (const node of nodes) {
    if (node.name === name) return node;
    const child = findSpan(node.children, name);
    if (child) return child;
  }
  return undefined;
}

async function fetchSplit(url: string): Promise<{
  status: string | undefined;
  prelude: string;
  resumed: string;
}> {
  const res = await fetch(url, { headers: HTML_HEADERS });
  expect(res.status).toBe(200);
  const html = await res.text();
  const preludeEnd = html.indexOf("</html>");
  expect(preludeEnd).toBeGreaterThan(-1);
  return {
    status: res.headers.get("x-rango-shell") ?? undefined,
    prelude: html.slice(0, preludeEnd),
    resumed: html.slice(preludeEnd),
  };
}

function describePprCaptureTimeout(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";

  test.describe(`ppr capture timeout (${label})`, () => {
    const f = useFixture({ root: ".", mode });

    test("nameless ppr route engages: MISS then HIT (issue #714)", async ({
      request,
    }) => {
      test.setTimeout(60_000);
      const url = f.url("/ppr-nameless/e2e?probe=nameless714");
      const first = await request.get(url, { headers: HTML_HEADERS });
      expect(first.status()).toBe(200);
      expect(first.headers()["x-rango-shell"]).toBe("MISS");
      const html = await first.text();
      expect(html).toContain("Live price:");

      // Window must fit attempt + in-place retry at the 15s default budget on a cold graph.
      await expect(async () => {
        const res = await request.get(url, { headers: HTML_HEADERS });
        expect(res.status()).toBe(200);
        expect(res.headers()["x-rango-shell"]).toBe("HIT");
      }).toPass({ timeout: 40_000 });

      const hit = await fetchSplit(url);
      expect(hit.status).toBe("HIT");
      expect(hit.resumed).toContain("Live price:");
    });

    test("captureTimeout admits staged deferred material: MISS -> HIT with ALL parts baked in the stored prelude (issue #715)", async ({
      request,
    }) => {
      test.setTimeout(150_000);
      const url = f.url("/ppr-slow-meta?probe=ct715");
      const first = await request.get(url, {
        headers: HTML_HEADERS,
        timeout: SLOW_REQUEST_TIMEOUT_MS,
      });
      expect(first.status()).toBe(200);
      expect(first.headers()["x-rango-shell"]).toBe("MISS");

      await expect(async () => {
        const res = await request.get(url, {
          headers: HTML_HEADERS,
          timeout: SLOW_REQUEST_TIMEOUT_MS,
        });
        expect(res.status()).toBe(200);
        expect(res.headers()["x-rango-shell"]).toBe("HIT");
      }).toPass({ timeout: SLOW_HIT_POLL_TIMEOUT_MS, intervals: [2_000] });

      // STORED-prelude assertion: the immediate part, the slow part, AND the
      // Meta title chained off the slow value are all baked RESOLVED, from
      // ONE capture render (same seq) — a partial prefix of the settlement
      // sequence must be unrepresentable.
      const hit = await fetchSplit(url);
      expect(hit.status).toBe("HIT");
      const seqMatch = hit.prelude.match(/ppr-slow-meta-immediate-(\d+)/);
      expect(seqMatch).not.toBeNull();
      const seq = seqMatch![1];
      expect(hit.prelude).toContain(`ppr-slow-meta-immediate-${seq}`);
      expect(hit.prelude).toContain(`ppr-slow-meta-slow-${seq}`);
      expect(hit.prelude).toContain(`ppr-slow-meta-slow-${seq}-chained`);
      expect(hit.prelude).toMatch(
        new RegExp(`<title[^>]*>[^<]*ppr-slow-meta-slow-${seq}-chained`),
      );

      // Frozen across consecutive HITs: the prelude replays the SAME capture
      // seq (handlers re-run for the live tail; the stored bytes are fixed).
      const second = await fetchSplit(url);
      expect(second.status).toBe("HIT");
      expect(second.prelude).toContain(`ppr-slow-meta-immediate-${seq}`);
      expect(second.prelude).toContain(`ppr-slow-meta-slow-${seq}-chained`);
    });

    test("a document capture overtakes queued navigation-only captures", async ({
      request,
    }) => {
      test.setTimeout(150_000);
      const probe = crypto.randomUUID();

      // A --no-deps subset skips dev-warmup. Prime the SSR capture graph before
      // measuring queue order; module transforms happen inside the active queue
      // task and are intentionally not a priority signal.
      if (mode === "dev") {
        const warmUrl = f.url(`/ppr-shell?probe=queue-priority-warm-${probe}`);
        await request.get(warmUrl, { headers: HTML_HEADERS });
        await expect(async () => {
          const response = await request.get(warmUrl, {
            headers: HTML_HEADERS,
          });
          expect(response.status()).toBe(200);
          expect(response.headers()["x-rango-shell"]).toBe("HIT");
        }).toPass({ timeout: 40_000, intervals: [1_000] });
      }

      const partialUrls = Array.from({ length: 5 }, (_, index) =>
        f.url(
          `/ppr-short-meta?probe=queue-priority-${probe}-${index}&_rsc_partial=true&_rsc_segments=`,
        ),
      );
      const partialHeaders = {
        "X-RSC-Router-Client-Path": f.url("/"),
        "X-Rango-Prefetch": "1",
      };
      const readTerminalBackground = async (
        token: string,
        timeoutMs: number,
      ): Promise<SpanNode> => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const trace = await request.get(f.url(`/?__trace_read=${token}`));
          expect(trace.status()).toBe(200);
          const background = findSpan(
            decodeTrace(await trace.text()),
            "rango.background",
          );
          if (background?.attributes["rango.background.outcome"]) {
            return background;
          }
          if (Date.now() > deadline) {
            throw new Error(
              `capture "${token}" had no terminal outcome within ${timeoutMs}ms`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      };

      // Model production viewport prefetch pressure with five cold partials.
      // Each navigation capture refuses only after two 1.5s attempts plus its
      // retry delay, so FIFO would consume the document's entire 15s wait
      // budget. Their response headers arrive before that detached work.
      const partials = await Promise.all(
        partialUrls.map((url) => fetch(url, { headers: partialHeaders })),
      );
      for (const partial of partials) {
        expect(partial.status).toBe(200);
        expect(partial.headers.get("x-rango-ppr-replay")).toBe(
          "BYPASS; reason=no-entry",
        );
      }
      const drains = partials.map((partial) => partial.arrayBuffer());

      const traceToken = `queue-priority-${probe}`;
      const documentUrl = f.url(
        `/ppr-shell?probe=queue-priority-document-${probe}&__trace_debug=${traceToken}`,
      );
      const first = await request.get(documentUrl, { headers: HTML_HEADERS });
      expect(first.status()).toBe(200);
      expect(first.headers()["x-rango-shell"]).toBe("MISS");

      // The active navigation capture finishes first; the document must run
      // next instead of waiting behind all queued speculative snapshots and
      // reaching the 15s skip-queue-timeout path. Read the post-handoff trace
      // from the same workerd isolate: KV shell visibility is not the queue
      // signal, while the terminal background span is.
      const background = await readTerminalBackground(traceToken, 25_000);
      expect(background.attributes["rango.background.outcome"]).toBe("stored");
      const queueWait = background.attributes["rango.background.queue_wait_ms"];
      expect(typeof queueWait).toBe("number");
      expect(queueWait).toBeGreaterThan(1_000);
      expect(queueWait).toBeLessThan(15_000);

      await expect(async () => {
        const response = await request.get(documentUrl, {
          headers: HTML_HEADERS,
        });
        expect(response.status()).toBe(200);
        expect(response.headers()["x-rango-shell"]).toBe("HIT");
      }).toPass({ timeout: 20_000, intervals: [1_000] });

      await Promise.all(drains);
      // A queued request's waitUntil may be terminated by workerd without a
      // terminal span. Allow the bounded queue window to close before another
      // test reuses the shared server.
      await new Promise((resolve) => setTimeout(resolve, 16_000));
    });

    test("budget shorter than the settlement sequence refuses: stays MISS, no partial bake (issue #715 negative)", async ({
      request,
    }) => {
      test.setTimeout(90_000);
      const url = f.url("/ppr-short-meta?probe=ct715neg");
      const first = await request.get(url, {
        headers: HTML_HEADERS,
        timeout: SLOW_REQUEST_TIMEOUT_MS,
      });
      expect(first.status()).toBe(200);
      expect(first.headers()["x-rango-shell"]).toBe("MISS");

      // Wait past two full short-budget attempts, then re-probe twice: still
      // MISS — the capture refused rather than storing a shell with an
      // unsettled/partial head snapshot.
      await new Promise((r) => setTimeout(r, SHORT_BUDGET_REFUSAL_MS));
      for (let i = 0; i < 2; i++) {
        const res = await request.get(url, {
          headers: HTML_HEADERS,
          timeout: SLOW_REQUEST_TIMEOUT_MS,
        });
        expect(res.status()).toBe(200);
        expect(res.headers()["x-rango-shell"]).toBe("MISS");
        // The axis-1 document still carries the fully settled material (the
        // live render awaits the pushes) — only the CACHING is off.
        const html = await res.text();
        expect(html).toMatch(/ppr-short-meta-slow-\d+-chained/);
      }
    });
  });
}

describePprCaptureTimeout("dev");
describePprCaptureTimeout("build");
