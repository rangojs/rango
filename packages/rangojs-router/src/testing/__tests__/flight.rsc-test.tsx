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

// A Server Component that reverses a route name, proving ctx.reverse resolves
// against the SCOPED routeMap option rather than the global route map.
async function ReverseEcho(): Promise<React.ReactElement> {
  const ctx = getRequestContext();
  return <span>url={ctx.reverse("product", { id: "5" })}</span>;
}

// A Server Component that reads the active theme, proving the Flight primitive
// populates themeConfig on the request context (like renderHandler does).
async function ThemeEcho(): Promise<React.ReactElement> {
  const ctx = getRequestContext();
  // Compose into a single string so it serializes contiguously (Flight splits
  // `theme={x}` JSX into a children array, not one string).
  return <span>{`theme=${String(ctx.theme)}`}</span>;
}

// A Server Component that throws during render.
async function Boom(): Promise<React.ReactElement> {
  await Promise.resolve();
  throw new Error("KABOOM from server component");
}

// Simulates the missing-rsc-alias trap: when `rangoTestAliases` is not wired,
// a server component reading getRequestContext()/cookies()/headers() resolves
// the out-of-react-server stub (index.ts), which throws this exact message.
async function StubReader(): Promise<React.ReactElement> {
  await Promise.resolve();
  throw new Error(
    'cookies() is only available from "@rangojs/router" in a react-server/RSC ' +
      'environment. For client hooks and components, import from "@rangojs/router/client".',
  );
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
      request: "http://localhost/items/42",
      params: { id: "42" },
      routeName: "items.show",
    });
    expect(flight).toMatchFlight("id=");
    expect(flight).toMatchFlight("42");
  });

  // #572 / #582 item: ctx.reverse() must resolve against the SCOPED routeMap
  // option, not the global route map (which is order-dependent on whatever
  // router registered last). With no router registered in this bare RSC test,
  // the global map has no "product", so only the scoped option can resolve it.
  it("scopes ctx.reverse() to the provided routeMap option", async () => {
    const flight = await renderToFlightString(<ReverseEcho />, {
      routeMap: { product: "/scoped/products/:id" },
    });
    expect(flight).toMatchFlight("url=");
    expect(flight).toMatchFlight("/scoped/products/5");
  });

  // I4: renderToFlightString must thread themeConfig into the request context
  // (like renderHandler), so a server component reading ctx.theme is testable.
  // The theme is resolved from the request cookie -> deterministic.
  it("populates ctx.theme when the theme option is passed", async () => {
    const flight = await renderToFlightString(<ThemeEcho />, {
      request: new Request("http://localhost/", {
        headers: { Cookie: "theme=dark" },
      }),
      theme: true,
    });
    expect(flight).toMatchFlight("theme=dark");
  });

  // Non-vacuity: without the theme option, ctx.theme is undefined (an app with
  // no theme configured), so the assertion above genuinely depends on the fix.
  it("leaves ctx.theme undefined when the theme option is omitted", async () => {
    const flight = await renderToFlightString(<ThemeEcho />, {
      request: new Request("http://localhost/", {
        headers: { Cookie: "theme=dark" },
      }),
    });
    expect(flight).toMatchFlight("theme=undefined");
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

  it("reclassifies the missing-rsc-alias stub error with actionable guidance", async () => {
    // Without rangoTestAliases, a context-reading server component hits the
    // out-of-react-server stub and the raw message is opaque. The Flight path
    // now self-diagnoses, naming rangoTestAliases like renderHandler does.
    await expect(renderToFlightString(<StubReader />)).rejects.toThrow(
      /rangoTestAliases/,
    );
  });

  it("does NOT reclassify a genuine server-component error", async () => {
    // Non-vacuity for the predicate: a normal render error keeps its message and
    // is never rewritten with the rsc-alias guidance.
    await expect(renderToFlightString(<Boom />)).rejects.toThrow(
      /KABOOM from server component/,
    );
    await expect(renderToFlightString(<Boom />)).rejects.not.toThrow(
      /rangoTestAliases/,
    );
  }, 2000);

  it("throws a migration error for the legacy { url } option", async () => {
    // The { url } option was renamed to { request }. A plain-JS / spread-defeated
    // consumer still passing it would otherwise have it SILENTLY ignored and
    // render against the default origin; the runtime guard surfaces it instead.
    await expect(
      // @ts-expect-error legacy option removed; runtime guard catches it.
      renderToFlightString(<Greeting name="Ada" />, { url: "/legacy" }),
    ).rejects.toThrow(/`url` option was renamed to `request`/);
  });
});
