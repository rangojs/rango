import { urls, createHandle, createLoader } from "@rangojs/router";
import { PriceDisplay } from "../components/PriceDisplay.js";

export const RenderedProducts = createHandle<string>();

const PRICE_MAP: Record<string, number> = {
  "widget-a": 9.99,
  "widget-b": 19.99,
  "widget-c": 29.99,
};

export const LivePricesLoader = createLoader(async (ctx) => {
  "use server";
  await ctx.rendered();
  const productIds = ctx.use(RenderedProducts);
  const prices: Record<string, number> = {};
  for (const id of productIds) {
    prices[id] = PRICE_MAP[id] ?? 0;
  }
  return { prices, fetchedAt: Date.now() };
});

function RenderedBarrierPage(ctx: any) {
  const push = ctx.use(RenderedProducts);
  push("widget-a");
  push("widget-b");
  push("widget-c");

  return (
    <div data-testid="rendered-barrier-page">
      <h1 data-testid="rendered-barrier-title">Rendered Barrier</h1>
      <p data-testid="rendered-barrier-ids">widget-a,widget-b,widget-c</p>
      <PriceDisplay loader={LivePricesLoader} testId="rendered-barrier" />
    </div>
  );
}

export const renderedBarrierPatterns = urls(({ path, loader }) => [
  path("/", RenderedBarrierPage, { name: "index" }, () => [
    loader(LivePricesLoader),
  ]),
]);
