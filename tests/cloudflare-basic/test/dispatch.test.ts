import { describe, expect, it } from "vitest";
import { dispatch } from "@rangojs/router/testing";
import { createRouter } from "@rangojs/router";
import { apiPatterns } from "../src/api/urls.js";
import type { AppBindings } from "../src/env.js";

// Dogfood `dispatch` against the cloudflare-basic app's REAL API route handlers.
//
// Why a router built from `apiPatterns` rather than `import { router }`:
// the full app router file (src/router.tsx) can't be imported in bare vitest —
// its page modules pull app-specific deps and/or plugin `virtual:` modules that
// need the rango Vite plugin. (Handler $$id is NOT the blocker: Prerender()/
// createLoader()/Static() each get a process-stable fallback id in a bare test.)
// The app's API include (src/api/urls.tsx) uses only path.json(...) with real
// handler bodies — no page-module imports — so it imports and dispatches cleanly
// with just the vitest.config.ts aliases (no per-file vi.mock). This is the
// realistic consumer pattern for unit-testing response/API routes.
//
// (See test/FINDINGS.md for the full account of why the documented "mock
// plugin-rsc + import your router" recipe is insufficient for a real app.)
// dispatch() now accepts the public Rango router type directly (no cast) —
// fixed as part of this dogfood.
const router = createRouter<AppBindings>({}).routes(apiPatterns);

const env = {
  KV: {
    get: async () => null,
    put: async () => undefined,
    list: async () => ({ keys: [] as { name: string }[] }),
    delete: async () => undefined,
  },
} as unknown as AppBindings;

describe("dispatch against cloudflare-basic API route handlers", () => {
  it("serializes /health as the bare handler value (no envelope)", async () => {
    const res = await dispatch(router, { request: "/health", env });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/json;charset=utf-8",
    );
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
    expect(typeof body.status).toBe("string");
  });

  it("serializes the full /products list from the real handler", async () => {
    const res = await dispatch(router, { request: "/products", env });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      name: string;
      price: number;
    }>;
    expect(body).toHaveLength(3);
    expect(body[0]).toMatchObject({
      id: "1",
      name: "Widget",
      price: 9.99,
    });
  });

  it("resolves the :id route param in /products/:id", async () => {
    const res = await dispatch(router, { request: "/products/2", env });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      name: string;
      description: string;
    };
    expect(body.id).toBe("2");
    expect(body.name).toBe("Gadget");
    expect(body.description).toContain("2");
  });

  it("maps the handler's thrown RouterError to a 404 + RFC 9457 problem+json", async () => {
    // The real handler does: throw new RouterError("NOT_FOUND", ..., { status: 404 })
    const res = await dispatch(router, { request: "/products/999", env });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe(
      "application/problem+json;charset=utf-8",
    );
    const body = (await res.json()) as {
      title: string;
      status: number;
      detail: string;
      code?: string;
    };
    expect(body.code).toBe("NOT_FOUND");
    expect(body.detail).toContain("999");
    expect(body.title).toBe("Not Found");
    expect(body.status).toBe(404);
  });

  it("returns 404 for an unmatched path (this router has no catch-all)", async () => {
    const res = await dispatch(router, { request: "/not-a-route", env });
    expect(res.status).toBe(404);
  });
});
