import { describe, expect, it } from "vitest";
import {
  flightMatchers,
  renderToFlightString,
} from "@rangojs/router/testing/flight";

expect.extend(flightMatchers);

// Real Flight (RSC) rendering of a pure leaf server component (mini's own server
// components read handler context via ctx.use(...), which is outside v1 flight
// scope — see the cloudflare-basic FINDINGS for why barrel server APIs can't be
// flight-tested in a bare project). This pins the real serializer for mini.
async function MiniGreeting({
  name,
}: {
  name: string;
}): Promise<React.ReactElement> {
  await Promise.resolve();
  return <p>Welcome to Mini, {name}.</p>;
}

describe("renderToFlightString for the mini app", () => {
  it("serializes a pure leaf server component to a real Flight string", async () => {
    const flight = await renderToFlightString(<MiniGreeting name="Ada" />);
    expect(typeof flight).toBe("string");
    expect(flight).toMatchFlight("Welcome to Mini");
    expect(flight).toMatchFlight("Ada");
  });
});
