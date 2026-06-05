import { describe, expect, it } from "vitest";
import {
  flightMatchers,
  renderToFlightString,
} from "@rangojs/router/testing/flight";

expect.extend(flightMatchers);

// Real Flight (RSC) rendering of a pure leaf server component. (Server components
// that read handler context via ctx.use(...) / getRequestContext are outside v1
// flight scope — see the cloudflare-basic FINDINGS.)
async function PriceTag({
  label,
  price,
}: {
  label: string;
  price: number;
}): Promise<React.ReactElement> {
  await Promise.resolve();
  return (
    <span>
      {label}: ${price.toFixed(2)}
    </span>
  );
}

describe("renderToFlightString for vite-rsc-demo", () => {
  it("serializes a pure leaf server component to a real Flight string", async () => {
    const flight = await renderToFlightString(
      <PriceTag label="Headphones" price={99.99} />,
    );
    expect(typeof flight).toBe("string");
    expect(flight).toMatchFlight("Headphones");
    expect(flight).toMatchFlight("99.99");
  });
});
