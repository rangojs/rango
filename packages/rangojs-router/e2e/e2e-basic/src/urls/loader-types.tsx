import { urls, type Handler } from "@rangojs/router";
import { ReactNodeTestLoader, NullTestLoader } from "../loaders.js";

const ReactNodeCachedHandler: Handler<"loaderTypes.reactNodeCached"> = async (
  ctx,
) => {
  const node = await ctx.use(ReactNodeTestLoader);
  return (
    <div data-testid="react-node-cached-page">
      <h1>ReactNode Cached Loader</h1>
      <div data-testid="react-node-content">{node}</div>
    </div>
  );
};

const ReactNodeNonCachedHandler: Handler<
  "loaderTypes.reactNodeNonCached"
> = async (ctx) => {
  const node = await ctx.use(ReactNodeTestLoader);
  return (
    <div data-testid="react-node-non-cached-page">
      <h1>ReactNode Non-Cached Loader</h1>
      <div data-testid="react-node-content">{node}</div>
    </div>
  );
};

const NullCachedHandler: Handler<"loaderTypes.nullCached"> = async (ctx) => {
  const data = await ctx.use(NullTestLoader);
  return (
    <div data-testid="null-cached-page">
      <h1>Null Cached Loader</h1>
      <p data-testid="null-value">
        {data.value === null ? "null" : "not-null"}
      </p>
      <p data-testid="null-count">{data.count}</p>
    </div>
  );
};

const NullNonCachedHandler: Handler<"loaderTypes.nullNonCached"> = async (
  ctx,
) => {
  const data = await ctx.use(NullTestLoader);
  return (
    <div data-testid="null-non-cached-page">
      <h1>Null Non-Cached Loader</h1>
      <p data-testid="null-value">
        {data.value === null ? "null" : "not-null"}
      </p>
      <p data-testid="null-count">{data.count}</p>
    </div>
  );
};

export const loaderTypePatterns = urls(({ path, loader, cache }) => [
  path(
    "/react-node-cached",
    ReactNodeCachedHandler,
    {
      name: "reactNodeCached",
    },
    () => [loader(ReactNodeTestLoader, () => [cache({ ttl: 600 })])],
  ),

  path(
    "/react-node-non-cached",
    ReactNodeNonCachedHandler,
    {
      name: "reactNodeNonCached",
    },
    () => [loader(ReactNodeTestLoader)],
  ),

  path(
    "/null-cached",
    NullCachedHandler,
    {
      name: "nullCached",
    },
    () => [loader(NullTestLoader, () => [cache({ ttl: 600 })])],
  ),

  path(
    "/null-non-cached",
    NullNonCachedHandler,
    {
      name: "nullNonCached",
    },
    () => [loader(NullTestLoader)],
  ),
]);
