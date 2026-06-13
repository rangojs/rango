import { describe, expect, it } from "vitest";
import { runMiddleware } from "@rangojs/router/testing";
import {
  mockAuthMiddleware,
  requireAuthMiddleware,
} from "../src/handlers/shop/middleware/auth.js";
import { permissionsMiddleware } from "../src/handlers/shop/middleware/permissions.js";

// Dogfood runMiddleware against vite-rsc-demo's REAL exported shop middleware
// (`Middleware[]` arrays). This is the richest middleware target across the apps:
// mockAuthMiddleware injects a typed user into ctx, and downstream middleware
// read it via ctx.get("user"). runMiddleware runs them through the router's real
// executeMiddleware, so the ctx propagation matches production.
describe("runMiddleware against vite-rsc-demo shop middleware", () => {
  it("mockAuthMiddleware injects a typed user and passes through", async () => {
    const { ctx, nextCalled } = await runMiddleware(mockAuthMiddleware, {
      request: "/shop",
    });
    expect(nextCalled).toBe(1); // ran the terminal handler
    expect(ctx.get("user")).toMatchObject({
      id: "user-123",
      name: "John Doe",
      email: "john@example.com",
    });
  });

  it("requireAuthMiddleware passes through when a prior mw set the user", async () => {
    // Chain auth -> requireAuth: the second reads the user the first set.
    const { nextCalled } = await runMiddleware(
      [...mockAuthMiddleware, ...requireAuthMiddleware],
      { request: "/shop/checkout" },
    );
    expect(nextCalled).toBe(1);
  });

  it("permissionsMiddleware reads the user set upstream (combined chain)", async () => {
    const { ctx, nextCalled } = await runMiddleware(
      [...mockAuthMiddleware, ...permissionsMiddleware],
      { request: "/shop/account/orders" },
    );
    expect(nextCalled).toBe(1);
    expect(ctx.get("user")).toBeTruthy();
  });

  it("requireAuthMiddleware with no user still passes through (logs, does not block)", async () => {
    // The demo's requireAuth only logs when unauthenticated; it does not throw or
    // short-circuit. Pin that observable contract.
    const { response, nextCalled } = await runMiddleware(
      requireAuthMiddleware,
      {
        request: "/shop/checkout",
      },
    );
    expect(nextCalled).toBe(1);
    expect(response.status).toBe(200);
  });
});
