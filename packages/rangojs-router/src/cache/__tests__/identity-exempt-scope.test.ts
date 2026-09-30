/**
 * #976: a key(), a store keyGenerator, a condition() and onError run under
 * runIdentityExempt, where identity reads are allowed and record nothing.
 * The exemption is an async-local value, so without care it follows every
 * continuation the callback starts: a "use cache" body a key() awaits, or a
 * loader body it starts with ctx.use(), ran with the guard off. The cached
 * body then stored the first caller's cookie or header under a key that
 * does not include it, and served it to the next caller. A cached body, a
 * loader body and a segment funnel each end the exemption on entry.
 */
import { describe, expect, it, vi } from "vitest";

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

import { registerCachedFunction } from "../cache-runtime.js";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import { resolveCacheKey } from "../cache-policy.js";
import { captureRecordedTags, recordedIdentityRead } from "../cache-tag.js";
import {
  createRequestContext,
  getRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";
import { cookies } from "../../server/cookie-store.js";
import {
  getContext,
  runInsideLoaderBodyScope,
  RangoContext,
} from "../../server/context.js";
import { runIdentityExempt } from "../cache-exec-scope.js";
import { invokeOnError } from "../../router/error-handling.js";

function inRequest<T>(
  store: MemorySegmentCacheStore,
  visitor: string,
  fn: () => T,
): T {
  const url = new URL("https://shop.test/nav");
  const ctx = createRequestContext({
    env: {},
    request: new Request(url, {
      headers: { "x-tenant": visitor, cookie: `session=${visitor}` },
    }),
    url,
    variables: {},
    cacheStore: store,
    cacheProfiles: { default: { ttl: 60 } },
  });
  return runWithRequestContext(ctx, fn);
}

/** "use cache" functions reading identity, keyed by nothing. */
function cachedReads(id: string) {
  return [
    [
      "ctx.request.headers",
      registerCachedFunction(
        async () => `t:${getRequestContext().request.headers.get("x-tenant")}`,
        `exempt#${id}-headers`,
        "default",
      ),
      /ctx\.request\.headers cannot be read inside a "use cache" function/,
    ],
    [
      "cookies()",
      registerCachedFunction(
        async () => `s:${cookies().get("session")?.value}`,
        `exempt#${id}-cookies`,
        "default",
      ),
      /cookies\(\) cannot be called inside a "use cache" function/,
    ],
  ] as const;
}

describe('a "use cache" body started inside an exempt callback is guarded (#976)', () => {
  for (const [surface, cached, message] of cachedReads("key")) {
    it(`a key() awaiting a cached function that reads ${surface}`, async () => {
      const store = new MemorySegmentCacheStore();
      const key = async () => cached();
      for (const visitor of ["a", "b"]) {
        await expect(
          inRequest(store, visitor, () => resolveCacheKey(key, null, "d")),
        ).rejects.toThrow(message);
      }
    });
  }

  for (const [surface, cached, message] of cachedReads("generator")) {
    it(`a store keyGenerator awaiting a cached function that reads ${surface}`, async () => {
      const store = new MemorySegmentCacheStore();
      const keyed = new MemorySegmentCacheStore({
        keyGenerator: async () => cached(),
      });
      await expect(
        inRequest(store, "a", () => resolveCacheKey(undefined, keyed, "d")),
      ).rejects.toThrow(message);
    });
  }

  for (const [surface, cached, message] of cachedReads("onerror")) {
    it(`onError starting a cached function that reads ${surface}`, async () => {
      const store = new MemorySegmentCacheStore();
      await inRequest(store, "a", async () => {
        let started: Promise<string> | undefined;
        invokeOnError(
          () => {
            started = cached();
          },
          new Error("boom"),
          "rendering",
          {
            request: getRequestContext().request,
            url: getRequestContext().url,
          },
        );
        await expect(started).rejects.toThrow(message);
      });
    });
  }
});

describe("a loader body or a segment funnel started inside an exempt callback is guarded (#976)", () => {
  it("a loader body a key() starts with ctx.use() records its read for the #972 fill check", () => {
    const into = new Set<string>();
    inRequest(new MemorySegmentCacheStore(), "a", () =>
      captureRecordedTags(into, () =>
        runIdentityExempt(() =>
          runInsideLoaderBodyScope(() => cookies().get("session"), "L"),
        ),
      ),
    );
    expect(recordedIdentityRead(into)).toMatchObject({
      surface: "cookies()",
      bodyId: "L",
    });
  });

  it("the exempt callback's own read records nothing", () => {
    const into = new Set<string>();
    inRequest(new MemorySegmentCacheStore(), "a", () =>
      captureRecordedTags(into, () =>
        runIdentityExempt(() => cookies().get("session")),
      ),
    );
    expect(recordedIdentityRead(into)).toBeUndefined();
  });

  it("a segment funnel (Store.run) ends the exemption", () => {
    const store = getContext().getOrCreateStore("exempt-funnel");
    inRequest(new MemorySegmentCacheStore(), "a", () =>
      runIdentityExempt(() =>
        getContext().runWithStore(store, "#router", null, () => {
          RangoContext.getStore()!.insideCacheScope = true;
          expect(() => cookies()).toThrow(
            "cookies() cannot be called inside a cache() boundary",
          );
        }),
      ),
    );
  });
});
