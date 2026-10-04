/**
 * resolveProviderNonce — NonceProvider return-value normalization.
 *
 * false/"" are the per-request opt-out and MUST normalize to undefined: a
 * threaded falsy string would never write the nonce token (`if (nonce)` in
 * handler.ts) yet still read `!== undefined` at the ppr shell gate
 * (rsc-rendering.ts activeNonce), silently pinning a ppr route to axis 1
 * with no way to exempt its requests from an app-wide provider.
 */
import { describe, it, expect } from "vitest";
import { resolveProviderNonce } from "../nonce";

describe("resolveProviderNonce", () => {
  it("passes a non-empty string through verbatim", () => {
    expect(resolveProviderNonce("abc123")).toBe("abc123");
  });

  it("auto-generates for true", () => {
    const value = resolveProviderNonce(true);
    expect(typeof value).toBe("string");
    expect(value!.length).toBeGreaterThan(0);
    expect(resolveProviderNonce(true)).not.toBe(value);
  });

  it("normalizes the per-request opt-out (false and empty string) to undefined", () => {
    expect(resolveProviderNonce(false)).toBeUndefined();
    expect(resolveProviderNonce("")).toBeUndefined();
  });
});
