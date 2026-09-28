/**
 * Userland contract for #925 through runLoader: a "use cache" function that
 * reads a `createVar({ cache: false })` value throws instead of storing the
 * first request's value, and passing the value in as an argument is the fix.
 *
 * A consumer's "use cache" directive compiles to registerCachedFunction from
 * `@rangojs/router/cache-runtime` (vite/plugins/use-cache-transform.ts); the
 * test wraps with it directly. The Flight codec is replaced by JSON
 * (plugin-rsc is a virtual module vitest cannot resolve).
 */
import { describe, it, expect, vi } from "vitest";

function pluginRscMock() {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    createTemporaryReferenceSet: () => new Set(),
    createClientTemporaryReferenceSet: () => new Set(),
    encodeReply: async (args: unknown[]) => JSON.stringify(args),
    renderToReadableStream: (value: unknown) => {
      const bytes = encoder.encode(JSON.stringify(value) ?? "null");
      return new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    createFromReadableStream: async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      let result = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        result += decoder.decode(value, { stream: true });
      }
      return JSON.parse(result + decoder.decode());
    },
  };
}
vi.mock("@vitejs/plugin-rsc/rsc/server", pluginRscMock);
vi.mock("@vitejs/plugin-rsc/rsc/client", pluginRscMock);

import {
  runLoader,
  runLoaderResult,
  type TestLoaderContext,
} from "../run-loader.js";
import { createVar } from "../../context-var.js";
import { getRequestContext } from "../../server/request-context.js";
import { registerCachedFunction } from "../../cache/cache-runtime.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";

const Tenant = createVar<string>({ cache: false });
const cacheProfiles = { default: { ttl: 60 } };

// async function getNav() { "use cache"; ... }
const getNav = registerCachedFunction(
  async () => `nav:${getRequestContext().get(Tenant)}`,
  "userland#925:getNav",
  "default",
);

// async function getNavFor(tenant: string) { "use cache"; ... }
const getNavFor = registerCachedFunction(
  async (tenant: string) => `nav:${tenant}`,
  "userland#925:getNavFor",
  "default",
);

describe('runLoader: "use cache" reading a { cache: false } var (#925)', () => {
  it("throws instead of storing the first request's value", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    for (const tenant of ["a", "b"]) {
      const { thrown } = await runLoaderResult(async () => getNav(), {
        vars: [[Tenant, tenant]],
        cacheStore,
        cacheProfiles,
      });
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(
        /inside a "use cache" function.*pass the value in as an argument/,
      );
    }
  });

  it("the loader reads the var and passes it in as an argument", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const loader = async (ctx: TestLoaderContext) =>
      getNavFor(ctx.get(Tenant)!);
    expect(
      await runLoader(loader, {
        vars: [[Tenant, "a"]],
        cacheStore,
        cacheProfiles,
      }),
    ).toBe("nav:a");
    expect(
      await runLoader(loader, {
        vars: [[Tenant, "b"]],
        cacheStore,
        cacheProfiles,
      }),
    ).toBe("nav:b");
  });
});
