import { describe, expect, it } from "vitest";
import {
  assertFlightRuntimeAvailable,
  flightMatchers,
  renderToFlightString,
} from "@rangojs/router/testing/flight";

expect.extend(flightMatchers);

// Real Flight (RSC) rendering of PURE leaf server components.
//
// SCOPE / known limitation (see test/FINDINGS.md): a server component that
// imports a server API from the `@rangojs/router` barrel (e.g. getRequestContext,
// cookies) CANNOT be flight-tested in bare vitest. Even under this react-server
// project, the bare `@rangojs/router` specifier resolves to the throwing
// server-only STUB (the `react-server` *condition* is not applied to
// bare-package exports resolution by Vitest); aliasing it to the real entry then
// fails on the router's `virtual:` imports, which need the rango Vite plugin.
// So flight tests here cover pure, import-light leaf trees — which is exactly
// the documented v1 scope ("server-only / leaf trees").

async function ProductCard({
  name,
  price,
}: {
  name: string;
  price: number;
}): Promise<React.ReactElement> {
  await Promise.resolve();
  return (
    <article>
      <h2>{name}</h2>
      <span>${price.toFixed(2)}</span>
    </article>
  );
}

describe("renderToFlightString against cloudflare-basic server components", () => {
  it("has the vendored serializer subpath available", () => {
    expect(() => assertFlightRuntimeAvailable()).not.toThrow();
  });

  it("serializes a pure leaf server component to a real Flight string", async () => {
    const flight = await renderToFlightString(
      <ProductCard name="Widget" price={9.99} />,
    );
    expect(typeof flight).toBe("string");
    expect(flight.length).toBeGreaterThan(0);
    expect(flight).toMatchFlight("Widget");
    expect(flight).toMatchFlight("9.99");
  });

  it("renders props passed through and matches a normalized snapshot", async () => {
    const flight = await renderToFlightString(
      <ProductCard name="Gadget" price={19.5} />,
    );
    expect(flight).toMatchFlight("Gadget");
    expect(flight).toMatchFlight("19.50");
    expect(flight).toMatchFlightSnapshot();
  });
});
