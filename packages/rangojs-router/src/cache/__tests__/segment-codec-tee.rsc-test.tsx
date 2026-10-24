/**
 * teeResult and isUnsupportedValueError against the vendored Flight server
 * (react-server-dom server.edge), which is what a "use cache" miss runs:
 * the decoded copy matches what a hit decodes from the stored text, and only
 * the errors Flight throws for a value it cannot encode count as
 * unsupported. A React upgrade that rewords those errors fails here instead
 * of silently failing the live fallback for such values.
 */
import { describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../../testing/vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../../testing/vitest-stubs/plugin-rsc.js"),
);

import {
  deserializeResult,
  isUnsupportedValueError,
  teeResult,
} from "../segment-codec.js";

class Money {
  constructor(readonly cents: number) {}
}

async function Throws(): Promise<React.ReactElement> {
  throw new Error("child down");
}

async function encodeErrors(value: unknown): Promise<unknown[]> {
  const errors: unknown[] = [];
  const teed = teeResult(value, (error) => {
    errors.push(error);
  });
  await teed?.serialized;
  await teed?.decoded.catch(() => {});
  return errors;
}

describe("teeResult", () => {
  it("decodes the copy a hit would decode from the stored text", async () => {
    const value = (
      <ul>
        <li>one</li>
        <li>{2}</li>
      </ul>
    );
    const teed = teeResult(value);

    const serialized = await teed!.serialized;
    expect(serialized).toEqual(expect.any(String));
    expect(await teed!.decoded).toEqual(
      await deserializeResult(serialized as string),
    );
  });

  it("rejects the copy's root when the value cannot be encoded", async () => {
    const teed = teeResult({ price: new Money(250) }, () => {});

    await expect(teed!.decoded).rejects.toBeInstanceOf(Error);
    expect(await teed!.serialized).toEqual(expect.any(String));
  });
});

describe("isUnsupportedValueError", () => {
  it.each([
    ["a function", { fn: () => 2 }],
    ["an on* function", { onSave: () => {} }],
    ["a class instance", { price: new Money(250) }],
    ["a local symbol", { tag: Symbol("local") }],
  ])("recognizes Flight's error for %s", async (_label, value) => {
    const errors = await encodeErrors(value);

    expect(errors).toHaveLength(1);
    expect(isUnsupportedValueError(errors[0])).toBe(true);
  });

  it("does not count a component that throws, or a guard refusal", async () => {
    const errors = await encodeErrors(<Throws />);

    expect(errors).toHaveLength(1);
    expect(isUnsupportedValueError(errors[0])).toBe(false);
    expect(
      isUnsupportedValueError(
        new Error('cookies() cannot be called inside a "use cache" function.'),
      ),
    ).toBe(false);
  });
});
