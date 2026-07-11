import { describe, it, expect, vi } from "vitest";
import {
  createCloudflareZonePurge,
  PURGE_TAGS_PER_CALL,
} from "../cf-zone-purge";

function okResponse() {
  return new Response(JSON.stringify({ success: true }), { status: 200 });
}

describe("createCloudflareZonePurge", () => {
  it("POSTs the tags to the zone purge endpoint with the bearer token", async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const purge = createCloudflareZonePurge({
      zoneId: "zone123",
      apiToken: "tok",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await purge(["rg:default:e:products"]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/zones/zone123/purge_cache",
    );
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      tags: ["rg:default:e:products"],
    });
  });

  it("chunks large tag lists under the per-call limit", async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const purge = createCloudflareZonePurge({
      zoneId: "z",
      apiToken: "t",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const tags = Array.from(
      { length: PURGE_TAGS_PER_CALL * 2 + 5 },
      (_, i) => `t${i}`,
    );
    await purge(tags);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const sizes = fetchImpl.mock.calls.map(
      (call) =>
        JSON.parse(String((call as unknown as [string, RequestInit])[1].body))
          .tags.length,
    );
    expect(sizes).toEqual([PURGE_TAGS_PER_CALL, PURGE_TAGS_PER_CALL, 5]);
  });

  it("rejects on an HTTP error, surfacing the API error detail", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 10000, message: "Authentication error" }],
          }),
          { status: 403 },
        ),
    );
    const purge = createCloudflareZonePurge({
      zoneId: "z",
      apiToken: "t",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(purge(["a"])).rejects.toThrow(/Authentication error/);
  });

  it("rejects on a 200 body reporting success: false", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: false }), { status: 200 }),
    );
    const purge = createCloudflareZonePurge({
      zoneId: "z",
      apiToken: "t",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(purge(["a"])).rejects.toThrow(/purge_cache failed/);
  });

  it("rejects a 200 whose body does not confirm success ({}, non-JSON, empty)", async () => {
    // Purge mode trusts surviving L1 entries on the strength of this call, so
    // an unconfirmed 2xx (proxy HTML page, empty body, {}) must NOT pass.
    for (const body of ["{}", "<html>oops</html>", ""]) {
      const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
      const purge = createCloudflareZonePurge({
        zoneId: "z",
        apiToken: "t",
        fetch: fetchImpl as unknown as typeof fetch,
      });
      await expect(purge(["a"])).rejects.toThrow(
        /missing\/invalid success body/,
      );
    }
  });

  it("respects an apiBase override", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      okResponse(),
    );
    const purge = createCloudflareZonePurge({
      zoneId: "z",
      apiToken: "t",
      apiBase: "https://proxy.example.com",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await purge(["a"]);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      "https://proxy.example.com/client/v4/zones/z/purge_cache",
    );
  });
});
