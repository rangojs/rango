import { describe, it, expect } from "vitest";
import type { SSRStreamMode } from "../../router/router-options.js";

/**
 * The resolveStreamMode logic from handler.ts extracted for testability.
 * This mirrors the implementation in createRSCHandler.
 */
function createResolveStreamMode<TEnv>(
  resolveStreaming?: (context: {
    request: Request;
    env: TEnv;
    url: URL;
  }) => SSRStreamMode | Promise<SSRStreamMode>,
) {
  return async (
    request: Request,
    env: TEnv,
    url: URL,
  ): Promise<SSRStreamMode> => {
    if (!resolveStreaming) return "stream";
    return resolveStreaming({ request, env, url });
  };
}

describe("resolveStreamMode", () => {
  const url = new URL("https://example.com/page");
  const request = new Request(url);
  const env = { FOO: "bar" };

  it('returns "stream" when no resolveStreaming is configured', async () => {
    const resolve = createResolveStreamMode<typeof env>(undefined);
    expect(await resolve(request, env, url)).toBe("stream");
  });

  it('returns "allReady" when resolver says so', async () => {
    const resolve = createResolveStreamMode<typeof env>(() => "allReady");
    expect(await resolve(request, env, url)).toBe("allReady");
  });

  it('returns "stream" when resolver says so', async () => {
    const resolve = createResolveStreamMode<typeof env>(() => "stream");
    expect(await resolve(request, env, url)).toBe("stream");
  });

  it("supports async resolvers", async () => {
    const resolve = createResolveStreamMode<typeof env>(
      async () => "allReady" as const,
    );
    expect(await resolve(request, env, url)).toBe("allReady");
  });

  it("passes request, env, and url to the resolver", async () => {
    let received: { request: Request; env: typeof env; url: URL } | undefined;
    const resolve = createResolveStreamMode<typeof env>((ctx) => {
      received = ctx;
      return "stream";
    });
    await resolve(request, env, url);
    expect(received).toBeDefined();
    expect(received!.request).toBe(request);
    expect(received!.env).toBe(env);
    expect(received!.url).toBe(url);
  });

  it("propagates errors from the resolver", async () => {
    const resolve = createResolveStreamMode<typeof env>(() => {
      throw new Error("bot detection failed");
    });
    await expect(resolve(request, env, url)).rejects.toThrow(
      "bot detection failed",
    );
  });
});
