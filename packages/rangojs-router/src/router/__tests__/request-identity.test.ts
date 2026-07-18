import { describe, expect, it } from "vitest";
import {
  getActiveRequestTransaction,
  getRequestIdentity,
  runWithRequestTransaction,
} from "../request-identity.js";

describe("request identity", () => {
  it("keeps inbound correlation separate from the server-owned request ID", () => {
    const request = new Request("http://localhost/test", {
      headers: {
        "x-rsc-router-request-id": "browser-42",
        "x-request-id": "proxy-7",
      },
    });

    const identity = getRequestIdentity(request);
    expect(identity.requestId).toMatch(
      /^req-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(identity.requestId).not.toBe("browser-42");
    expect(identity.clientCorrelationId).toBe("browser-42");
    expect(getRequestIdentity(request)).toBe(identity);
  });

  it("rejects oversized and control-character correlation values", () => {
    const oversized = new Request("http://localhost/test", {
      headers: { "x-request-id": "x".repeat(129) },
    });
    const controlled = new Request("http://localhost/test", {
      headers: { "x-request-id": "bad\u007fvalue" },
    });

    expect(getRequestIdentity(oversized).clientCorrelationId).toBeNull();
    expect(getRequestIdentity(controlled).clientCorrelationId).toBeNull();
  });

  it("assigns unique child transaction IDs and inherits router diagnostics", () => {
    const request = new Request("http://localhost/test");
    const seen: string[] = [];

    runWithRequestTransaction(
      request,
      "request",
      () => {
        const root = getActiveRequestTransaction();
        expect(root).toMatchObject({
          transactionId: "request-tx-1",
          routerId: "shop",
          diagnosticsEnabled: true,
        });
        seen.push(root!.requestId);

        runWithRequestTransaction(request, "match", () => {
          const match = getActiveRequestTransaction();
          expect(match).toMatchObject({
            transactionId: "match-tx-2",
            routerId: "shop",
            diagnosticsEnabled: true,
          });
          seen.push(match!.requestId);
        });
      },
      { routerId: "shop", diagnosticsEnabled: true },
    );

    expect(seen[0]).toBe(seen[1]);
    expect(getActiveRequestTransaction()).toBeUndefined();
  });
});
