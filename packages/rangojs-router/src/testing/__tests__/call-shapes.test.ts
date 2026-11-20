import { describe, expect, it } from "vitest";
import { callShapes, type CallShapeName } from "./helpers/call-shapes.js";

async function outcomes<T extends object>(
  target: T,
  key: keyof T,
): Promise<Record<CallShapeName, unknown>> {
  const out = {} as Record<CallShapeName, unknown>;
  for (const shape of callShapes(target, key)) {
    out[shape.name] = await shape
      .call(2)
      .catch((e: Error) => e.constructor.name);
  }
  return out;
}

describe("callShapes", () => {
  it("a method that closes over its value works in every shape", async () => {
    const value = 3;
    const target = { times: (n: unknown) => value * (n as number) };
    expect(await outcomes(target, "times")).toEqual({
      method: 6,
      detached: 6,
      spread: 6,
      "spread detached": 6,
      "after await": 6,
      "after await detached": 6,
    });
  });

  it("a method that reads its receiver fails once it is detached", async () => {
    const target = {
      value: 3,
      times(this: { value: number }, n: unknown) {
        return this.value * (n as number);
      },
    };
    expect(await outcomes(target, "times")).toEqual({
      method: 6,
      detached: "TypeError",
      spread: 6,
      "spread detached": "TypeError",
      "after await": 6,
      "after await detached": "TypeError",
    });
  });

  it("a non-enumerable method is lost by a spread copy", async () => {
    const target = {} as { times(n: unknown): number };
    Object.defineProperty(target, "times", {
      value: (n: unknown) => 3 * (n as number),
      enumerable: false,
    });
    expect(await outcomes(target, "times")).toEqual({
      method: 6,
      detached: 6,
      spread: "TypeError",
      "spread detached": "TypeError",
      "after await": 6,
      "after await detached": 6,
    });
  });
});
