/**
 * A loader body entered inside a "use cache" function runs as part of that
 * function's body, so what it returns is stored in the entry, keyed without
 * what it read. Served through the public serveShellRequest: a non-cacheable
 * ctx.get() there refuses exactly as cookies() does, instead of storing the
 * first request's value and serving it to the next request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import { createRouter, urls, type HandlerContext } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import {
  Tenant,
  navFromSession,
  navFromTenant,
} from "./fixtures/identity-read-data.js";

async function TenantNavPage(ctx: HandlerContext): Promise<React.ReactNode> {
  return <p>{await navFromTenant(ctx)}</p>;
}

async function SessionNavPage(ctx: HandlerContext): Promise<React.ReactNode> {
  return <p>{await navFromSession(ctx)}</p>;
}

function setup() {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const errors: unknown[] = [];
  const router = createRouter({
    onError: (context) => {
      errors.push(context.error);
    },
  })
    .use(async (ctx, next) => {
      ctx.set(Tenant, ctx.request.headers.get("x-tenant") ?? "none");
      await next();
    })
    .routes(
      urls(({ path }) => [
        path("/tenant-nav", TenantNavPage, { name: "tenantNav" }),
        path("/session-nav", SessionNavPage, { name: "sessionNav" }),
      ]),
    );
  const cacheStore = new MemorySegmentCacheStore();
  const serve = (url: string, tenant: string) =>
    serveShellRequest(router, url, {
      cacheStore,
      headers: { "x-tenant": tenant, cookie: `session=${tenant}` },
    });
  const messages = () => errors.map((e) => (e as Error).message);
  return { serve, messages };
}

beforeEach(async () => {
  await resetShellTestState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a loader body entered inside a "use cache" function', () => {
  it.each([
    [
      "a non-cacheable ctx.get()",
      "/tenant-nav",
      "tenant-a",
      'ctx.get() for a non-cacheable variable cannot be called inside a "use cache" function',
    ],
    [
      "cookies()",
      "/session-nav",
      "session-a",
      'cookies() cannot be called inside a "use cache" function',
    ],
  ])(
    "refuses %s, so the next request is not served the first one's value",
    async (_label, url, firstValue, message) => {
      const { serve, messages } = setup();

      const first = await serve(url, "a");
      const second = await serve(url, "b");

      expect(second.body).not.toContain(firstValue);
      expect([first, second].map((s) => s.response.status)).toEqual([500, 500]);
      expect(messages()).toContainEqual(expect.stringContaining(message));
    },
  );
});
