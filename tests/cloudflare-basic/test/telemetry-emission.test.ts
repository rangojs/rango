import { describe, expect, it } from "vitest";
import { dispatch } from "@rangojs/router/testing";
import type { TelemetryEvent, TelemetrySink } from "@rangojs/router/testing";
import { createRouter } from "@rangojs/router";
import { apiPatterns } from "../src/api/urls.js";
import type { AppBindings } from "../src/env.js";

// Dogfood: a consumer wiring createRouter({ telemetry }) can unit-test that their
// sink receives the request lifecycle in-process, through the public `dispatch`
// primitive — no e2e run needed. dispatch owns request.start/end/error; the
// match-scoped cache.decision / loader.* events still require a real RSC request
// (the e2e suite), which is why cache-status.test.ts keeps its hit/miss/stale
// assertions at the e2e tier. Same router-from-apiPatterns pattern as
// dispatch.test.ts (the full app router can't be imported in bare vitest).

const env = {
  KV: {
    get: async () => null,
    put: async () => undefined,
    list: async () => ({ keys: [] as { name: string }[] }),
    delete: async () => undefined,
  },
} as unknown as AppBindings;

describe("telemetry sink receives dispatch lifecycle events", () => {
  it("captures request.start then request.end for a real API route", async () => {
    const events: TelemetryEvent[] = [];
    const sink: TelemetrySink = {
      emit(event: TelemetryEvent): void {
        events.push(event);
      },
    };
    const router = createRouter<AppBindings>({ telemetry: sink }).routes(
      apiPatterns,
    );

    const res = await dispatch(router, { request: "/health", env });
    expect(res.status).toBe(200);

    const types = events.map((e) => e.type);
    expect(types).toContain("request.start");
    expect(types).toContain("request.end");
    expect(types).not.toContain("request.error");

    const start = events.find((e) => e.type === "request.start")!;
    const end = events.find((e) => e.type === "request.end")!;
    if (start.type !== "request.start" || end.type !== "request.end") {
      throw new Error("unreachable");
    }
    expect(start.pathname).toBe("/health");
    expect(start.method).toBe("GET");
    expect(start.transaction).toBe("match");
    // One correlation id spans the transaction.
    expect(end.requestId).toBe(start.requestId);
    expect(end.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("emits nothing extra when no telemetry sink is configured (same response)", async () => {
    const router = createRouter<AppBindings>({}).routes(apiPatterns);
    const res = await dispatch(router, { request: "/health", env });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });
});
