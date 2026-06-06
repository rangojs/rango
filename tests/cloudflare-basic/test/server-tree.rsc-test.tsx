// Dogfood: renderServerTree + renderHandler against cloudflare-basic.
import { describe, expect, it } from "vitest";
import {
  assertFlightTreeRuntimeAvailable,
  findClientBoundaries,
  renderHandler,
  renderServerTree,
} from "@rangojs/router/testing/flight";
import { createLoader, type HandlerContext } from "@rangojs/router";
import { PriceTag } from "./fixtures/PriceTag.js";

const PriceLoader = createLoader(async () => ({ amount: 0, currency: "USD" }));

// A pure leaf server component wrapping a client island (the documented v1
// scope: import-light leaf trees). Mirrors the existing flight.rsc-test pattern.
async function ProductPanel({
  name,
  amount,
  asOf,
}: {
  name: string;
  amount: number;
  asOf: Date;
}): Promise<React.ReactElement> {
  await Promise.resolve();
  return (
    <article>
      <h2>{name}</h2>
      <PriceTag amount={amount} currency="USD" asOf={asOf} />
    </article>
  );
}

describe("renderServerTree against cloudflare-basic", () => {
  it("has the deserialize runtime available", () => {
    expect(() => assertFlightTreeRuntimeAvailable()).not.toThrow();
  });

  it("a pure server tree has no client boundaries", async () => {
    async function ServerOnly(): Promise<React.ReactElement> {
      await Promise.resolve();
      return <p>no islands here</p>;
    }
    const { flight, tree } = await renderServerTree(<ServerOnly />);
    expect(flight).not.toContain("I[");
    expect(findClientBoundaries(tree)).toEqual([]);
  });

  it("the client island crosses the boundary as an I-row, not inlined", async () => {
    // No clientComponents: the rsc config's rangoUseClientTransform() registers
    // PriceTag from its "use client" directive automatically.
    const { flight } = await renderServerTree(
      <ProductPanel name="Widget" amount={9.99} asOf={new Date(0)} />,
    );
    expect(flight).toContain("I[");
    expect(flight).toContain("PriceTag");
    expect(flight).toContain("Widget");
    // The island's RENDERED output (its data-testid) must NOT be in the server
    // payload — only its props cross the boundary, not its server-rendered DOM.
    expect(flight).not.toContain("price-tag");
  });

  it("props keep their JS types after the serialize -> deserialize round trip", async () => {
    const asOf = new Date("2026-01-02T03:04:05.000Z");
    const { tree } = await renderServerTree(
      <ProductPanel name="Gadget" amount={19.5} asOf={asOf} />,
    );

    const [priceTag, ...rest] = findClientBoundaries(tree, "PriceTag");
    expect(rest).toHaveLength(0);
    expect(priceTag.id).toContain("PriceTag.tsx");
    expect(priceTag.props.amount).toBe(19.5);
    expect(typeof priceTag.props.amount).toBe("number");
    expect(priceTag.props.currency).toBe("USD");
    expect(priceTag.props.asOf).toBeInstanceOf(Date);
    expect((priceTag.props.asOf as Date).toISOString()).toBe(
      "2026-01-02T03:04:05.000Z",
    );
  });

  it("renderHandler runs a real handler (params + seeded loader) and renders its RSC", async () => {
    // A route handler the way it's authored for path(): a (ctx) => rsc function.
    async function ProductHandler(ctx: HandlerContext<{ slug: string }>) {
      const price = await ctx.use(PriceLoader);
      return (
        <article>
          <h2>{ctx.params.slug}</h2>
          <PriceTag
            amount={price.amount}
            currency={price.currency}
            asOf={new Date(0)}
          />
        </article>
      );
    }

    const { tree } = await renderHandler(ProductHandler, {
      params: { slug: "wine" },
      loaders: [[PriceLoader, { amount: 12.5, currency: "USD" }]],
    });

    expect(JSON.stringify(tree)).toContain("wine"); // the param
    const [priceTag] = findClientBoundaries(tree, "PriceTag");
    expect(priceTag.props.amount).toBe(12.5); // from the seeded loader
    expect(priceTag.props.asOf).toBeInstanceOf(Date);
  });
});
