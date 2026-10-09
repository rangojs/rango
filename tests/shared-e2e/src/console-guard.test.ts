import { describe, expect, it } from "vitest";
import { consoleGuardVerdict } from "./console-guard.js";

const DENIED = ["[suspense-swap] [rango][suspense] I1 swap at content:S"];

describe("consoleGuardVerdict", () => {
  it("fails a passed test on a denied message", () => {
    expect(
      consoleGuardVerdict(DENIED, true, {
        status: "passed",
        expectedStatus: "passed",
      }),
    ).toBe("throw");
  });

  it("annotates an open case whose body passed, so Playwright reports the flip", () => {
    expect(
      consoleGuardVerdict(DENIED, true, {
        status: "passed",
        expectedStatus: "failed",
      }),
    ).toBe("annotate");
  });

  it("leaves a failed body, a record run and a quiet test alone", () => {
    expect(
      consoleGuardVerdict(DENIED, true, {
        status: "failed",
        expectedStatus: "failed",
      }),
    ).toBe("none");
    expect(
      consoleGuardVerdict(DENIED, false, {
        status: "passed",
        expectedStatus: "passed",
      }),
    ).toBe("none");
    expect(
      consoleGuardVerdict([], true, {
        status: "passed",
        expectedStatus: "passed",
      }),
    ).toBe("none");
  });
});
