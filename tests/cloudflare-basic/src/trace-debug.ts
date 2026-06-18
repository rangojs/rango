/**
 * Test-only recording tracer for the Cloudflare custom-spans e2e.
 *
 * Real Cloudflare spans (via executionContext.tracing) only surface in the
 * Workers trace waterfall / OpenTelemetry export, which an e2e test cannot
 * read. To assert span emission and nesting end-to-end in dev AND production,
 * the worker entry injects this recording tracer as `ctx.tracing` when a
 * request carries `?__trace_debug=1`, then serializes the captured tree into
 * the `X-Rango-Trace` response header for the test to assert against.
 *
 * It captures each span's name, attributes, and PARENTAGE at enterSpan-call
 * time, nesting by JS async context (via AsyncLocalStorage, available under the
 * `nodejs_als` compatibility flag) — faithful to CF, which also fixes the parent
 * from async context at that point. It ALSO records each span's settle ORDER
 * (endOrder) when its enterSpan callback settles — faithful to CF ending the
 * span at that moment — so the e2e can assert drain-bound validity (a streaming
 * phase whose callback awaits body-drain ends AFTER a loader child that resolved
 * mid-stream). For that to hold the worker drains the body BEFORE serializing
 * (see worker.rsc.tsx __trace_debug path); a span still open at serialize time
 * keeps endOrder -1. The router code under test is identical to production —
 * only the tracer is a stand-in for the platform's.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface RecordedSpan {
  name: string;
  attributes: Record<string, string | number | boolean>;
  children: RecordedSpan[];
  /**
   * Monotonic SETTLE order: the value of a shared counter at the moment this
   * span's enterSpan callback settled (its span ended). A lower number ended
   * first. Lets the e2e assert drain-bound validity — a loader child that
   * resolves while the body streams must end BEFORE its drain-bound render
   * parent (loader.endOrder < render.endOrder), which is impossible under the
   * old construction-bound spans where render ended first. -1 = still open at
   * serialize time (serialize before the body drained).
   */
  endOrder: number;
}

interface CloudflareSpanLike {
  readonly isTraced: boolean;
  setAttribute(key: string, value?: boolean | number | string): void;
}

interface CloudflareTracingLike {
  enterSpan<T>(name: string, callback: (span: CloudflareSpanLike) => T): T;
}

export interface RecordingTracer {
  tracing: CloudflareTracingLike;
  /** Serialize the recorded span tree to a base64 JSON string for a header. */
  serialize(): string;
}

export function createRecordingTracer(): RecordingTracer {
  const roots: RecordedSpan[] = [];
  const als = new AsyncLocalStorage<RecordedSpan>();
  let endSeq = 0;

  const tracing: CloudflareTracingLike = {
    enterSpan(name, callback) {
      const record: RecordedSpan = {
        name,
        attributes: {},
        children: [],
        endOrder: -1,
      };
      const parent = als.getStore();
      (parent ? parent.children : roots).push(record);

      const span: CloudflareSpanLike = {
        isTraced: true,
        setAttribute(key, value) {
          if (value !== undefined) record.attributes[key] = value;
        },
      };

      // Record the settle order when the callback (the wrapped phase work)
      // settles — this is when Cloudflare ends the span. Faithful to the
      // platform: a streaming phase whose callback awaits body-drain ends later
      // than a child loader that resolved mid-stream.
      const markEnd = (): void => {
        if (record.endOrder === -1) record.endOrder = endSeq++;
      };
      return als.run(record, () => {
        const out = callback(span);
        if (out instanceof Promise) {
          return out.then(
            (value) => {
              markEnd();
              return value;
            },
            (error) => {
              markEnd();
              throw error;
            },
          ) as ReturnType<typeof callback>;
        }
        markEnd();
        return out;
      });
    },
  };

  return {
    tracing,
    serialize() {
      const json = JSON.stringify(roots);
      // base64 so the JSON is a single safe header token.
      return btoa(unescape(encodeURIComponent(json)));
    },
  };
}
