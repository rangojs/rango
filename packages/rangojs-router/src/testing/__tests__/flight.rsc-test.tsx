/**
 * Example + self-verification for REAL Flight rendering.
 *
 * Runs only under the rsc vitest project (vitest.rsc.config.ts), which forces
 * the `react-server` export condition. An async Server Component is rendered to
 * its Flight wire string and asserted against rendered text and a normalized
 * snapshot.
 */

import { describe, it, expect } from "vitest";
import {
  renderToFlightString,
  normalizeFlight,
  assertFlightRuntimeAvailable,
} from "../flight.js";
import { flightMatchers } from "../flight-matchers.js";
import { getRequestContext } from "../../server/request-context.js";

expect.extend(flightMatchers);

// An async Server Component: awaits, then renders text. Real Flight serialize.
async function Greeting({
  name,
}: {
  name: string;
}): Promise<React.ReactElement> {
  await Promise.resolve();
  return <div>Hello {name}!</div>;
}

// A Server Component that reads the active request context (params), proving
// the render runs inside runWithRequestContext.
async function ParamEcho(): Promise<React.ReactElement> {
  const ctx = getRequestContext();
  return <span>id={ctx.params.id}</span>;
}

// A Server Component that throws during render.
async function Boom(): Promise<React.ReactElement> {
  await Promise.resolve();
  throw new Error("KABOOM from server component");
}

describe("renderToFlightString (Flight RSC)", () => {
  it("vendored serializer subpath resolves", () => {
    expect(() => assertFlightRuntimeAvailable()).not.toThrow();
  });

  it("renders an async server component to a Flight string containing the text", async () => {
    const flight = await renderToFlightString(<Greeting name="Ada" />);
    // Real wire string, not a stub.
    expect(typeof flight).toBe("string");
    expect(flight.length).toBeGreaterThan(0);
    // Rendered text is present in the payload.
    expect(flight).toContain("Hello ");
    expect(flight).toContain("Ada");
  });

  it("toMatchFlight asserts containment on the normalized string", async () => {
    const flight = await renderToFlightString(<Greeting name="Grace" />);
    expect(flight).toMatchFlight("Grace");
    expect(flight).toMatchFlight("Hello ");
  });

  it("exposes the active request context to server components", async () => {
    const flight = await renderToFlightString(<ParamEcho />, {
      url: "http://localhost/items/42",
      params: { id: "42" },
      routeName: "items.show",
    });
    expect(flight).toMatchFlight("id=");
    expect(flight).toMatchFlight("42");
  });

  it("normalizeFlight scrubs the dev reference row and file paths", () => {
    const dev =
      ":N1780553241432.4255\n" +
      '0:["$","div",null,{"children":"hi"},null,"$2",1]\n' +
      '2:[["Greeting","file:///abs/path/flight.rsc-test.tsx",6,16,4,1,false]]\n';
    const normalized = normalizeFlight(dev);
    expect(normalized).not.toContain("N1780553241432");
    expect(normalized).not.toContain("/abs/path/");
    expect(normalized).toContain("file://<path>");
    expect(normalized).toContain('"children":"hi"');
  });

  it("matches a normalized Flight snapshot", async () => {
    const flight = await renderToFlightString(<Greeting name="World" />);
    expect(flight).toMatchFlightSnapshot();
  });

  it("rejects (does not hang) when a server component throws", async () => {
    // Pre-fix, onError rethrew inside the serializer's scheduled work: the
    // stream never closed, the drain hung until the test timeout, and the error
    // escaped as an unhandled rejection. The fix captures the error and rejects
    // after draining — a clean, awaitable rejection. A 2s timeout proves it
    // does not hang (the bug took the full default 5s timeout).
    await expect(renderToFlightString(<Boom />)).rejects.toThrow(
      "KABOOM from server component",
    );
  }, 2000);
});
