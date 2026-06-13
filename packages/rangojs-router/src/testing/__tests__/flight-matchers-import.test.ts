// flight-matchers must be importable under the PLAIN node condition (this file
// is a `.test.ts`, picked up by the main vitest project, NOT the rsc project).
//
// Regression: flight-matchers used to import normalizeFlight from ./flight.js,
// whose top-level vendored-serializer import throws outside the `react-server`
// condition. A consumer wiring `expect.extend(flightMatchers)` in a shared
// setupFile then died with an opaque React-internals error. normalizeFlight now
// lives in a serializer-free module, so this import succeeds here.
import { describe, expect, test } from "vitest";

describe("flight-matchers import (node condition)", () => {
  test("imports without pulling in the vendored serializer", async () => {
    const mod = await import("../flight-matchers.js");
    expect(typeof mod.flightMatchers.toMatchFlight).toBe("function");
    expect(typeof mod.flightMatchers.toMatchFlightSnapshot).toBe("function");
  });

  test("the matchers operate on a normalized Flight string", async () => {
    const { flightMatchers } = await import("../flight-matchers.js");
    // A dev-shaped Flight string with a volatile :N reference row; the matcher
    // normalizes before the substring check, so the rendered text still matches.
    const flight =
      ":N1780553241432.4255\n" +
      '0:["$","div",null,{"children":"Hello Ada"},null]\n';
    expect(flightMatchers.toMatchFlight(flight, "Hello Ada").pass).toBe(true);
    expect(flightMatchers.toMatchFlight(flight, "N1780553241432").pass).toBe(
      false,
    );
  });

  test("normalizeFlight is importable serializer-free too", async () => {
    const { normalizeFlight } = await import("../flight-normalize.js");
    expect(normalizeFlight(":N123.4\nrest")).toBe("rest");
  });
});
