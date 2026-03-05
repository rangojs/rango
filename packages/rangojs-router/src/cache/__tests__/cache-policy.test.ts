import { describe, it, expect, vi, afterEach } from "vitest";
import {
  resolveTtl,
  resolveSwrWindow,
  computeExpiration,
  DEFAULT_ROUTE_TTL,
  DEFAULT_FUNCTION_TTL,
} from "../cache-policy.js";

describe("resolveTtl", () => {
  it("returns explicit value when provided", () => {
    expect(resolveTtl(30, { ttl: 60 }, 120)).toBe(30);
  });

  it("falls back to store defaults when explicit is undefined", () => {
    expect(resolveTtl(undefined, { ttl: 60 }, 120)).toBe(60);
  });

  it("falls back to fallback when both explicit and defaults are undefined", () => {
    expect(resolveTtl(undefined, undefined, 120)).toBe(120);
  });

  it("falls back to fallback when defaults has no ttl", () => {
    expect(resolveTtl(undefined, { swr: 10 }, 120)).toBe(120);
  });

  it("allows explicit 0", () => {
    expect(resolveTtl(0, { ttl: 60 }, 120)).toBe(0);
  });

  it("allows defaults 0", () => {
    expect(resolveTtl(undefined, { ttl: 0 }, 120)).toBe(0);
  });
});

describe("resolveSwrWindow", () => {
  it("returns explicit value when provided", () => {
    expect(resolveSwrWindow(30, { swr: 60 })).toBe(30);
  });

  it("falls back to store defaults when explicit is undefined", () => {
    expect(resolveSwrWindow(undefined, { swr: 60 })).toBe(60);
  });

  it("returns 0 when both are undefined", () => {
    expect(resolveSwrWindow(undefined, undefined)).toBe(0);
  });

  it("returns 0 when defaults has no swr", () => {
    expect(resolveSwrWindow(undefined, { ttl: 60 })).toBe(0);
  });

  it("allows explicit 0", () => {
    expect(resolveSwrWindow(0, { swr: 60 })).toBe(0);
  });
});

describe("computeExpiration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("computes staleAt and expiresAt from TTL", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000000);
    const result = computeExpiration(60);
    expect(result.staleAt).toBe(1000000 + 60 * 1000);
    expect(result.expiresAt).toBe(1000000 + 60 * 1000);
  });

  it("extends expiresAt by SWR window", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000000);
    const result = computeExpiration(60, 300);
    expect(result.staleAt).toBe(1000000 + 60 * 1000);
    expect(result.expiresAt).toBe(1000000 + (60 + 300) * 1000);
  });

  it("staleAt equals expiresAt when SWR is 0", () => {
    const result = computeExpiration(60, 0);
    expect(result.staleAt).toBe(result.expiresAt);
  });
});

describe("constants", () => {
  it("DEFAULT_ROUTE_TTL is 60", () => {
    expect(DEFAULT_ROUTE_TTL).toBe(60);
  });

  it("DEFAULT_FUNCTION_TTL is 900", () => {
    expect(DEFAULT_FUNCTION_TTL).toBe(900);
  });
});
