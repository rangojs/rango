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
 * from async context at that point. It intentionally does NOT model span
 * end/duration/settlement: the tree is serialized right after router.fetch
 * resolves (before the body streams), so on real CF a streaming rango.loader
 * span would still be open at serialize time. The e2e therefore asserts tree
 * SHAPE only, not lifecycle. The router code under test is identical to
 * production — only the tracer is a stand-in for the platform's.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface RecordedSpan {
  name: string;
  attributes: Record<string, string | number | boolean>;
  children: RecordedSpan[];
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

  const tracing: CloudflareTracingLike = {
    enterSpan(name, callback) {
      const record: RecordedSpan = { name, attributes: {}, children: [] };
      const parent = als.getStore();
      (parent ? parent.children : roots).push(record);

      const span: CloudflareSpanLike = {
        isTraced: true,
        setAttribute(key, value) {
          if (value !== undefined) record.attributes[key] = value;
        },
      };

      return als.run(record, () => callback(span));
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
