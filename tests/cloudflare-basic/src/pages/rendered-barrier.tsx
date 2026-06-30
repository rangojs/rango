import {
  urls,
  createHandle,
  createLoader,
  type LoaderContext,
} from "@rangojs/router";
import { PriceDisplay } from "../components/PriceDisplay.js";

// Flat list of product ids (opt into a single array; the default collect groups
// per segment).
export const RenderedProducts = createHandle<string, string[]>((s) => s.flat());

const PRICE_MAP: Record<string, number> = {
  "widget-a": 9.99,
  "widget-b": 19.99,
  "widget-c": 29.99,
};

// Body exported so the rendered-barrier loader can be unit-tested with
// runLoader({ rendered: true, handles: [[RenderedProducts, ids]] }) — the barrier
// is mocked and the handle data is seeded, exercising the price-mapping logic.
export async function livePricesLoaderBody(
  ctx: LoaderContext,
): Promise<{ prices: Record<string, number>; fetchedAt: number }> {
  "use server";
  await ctx.rendered();
  const productIds = ctx.use(RenderedProducts);
  const prices: Record<string, number> = {};
  for (const id of productIds) {
    prices[id] = PRICE_MAP[id] ?? 0;
  }
  return { prices, fetchedAt: Date.now() };
}

export const LivePricesLoader = createLoader(livePricesLoaderBody);

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
