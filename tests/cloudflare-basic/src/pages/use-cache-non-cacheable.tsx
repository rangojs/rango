import {
  createLoader,
  createVar,
  getRequestContext,
  type HandlerContext,
  type Middleware,
} from "@rangojs/router";

// Issue #925: a { cache: false } var read inside "use cache" throws. The key
// has no argument, so a stored result would carry the first caller's tenant
// to every later caller.
const RequestTenant = createVar<string>({ cache: false });

export const requestTenantMiddleware: Middleware = async (ctx, next) => {
  ctx.set(RequestTenant, ctx.url.searchParams.get("tenant") ?? "none");
  return next();
};

async function getTenantLabel(): Promise<string> {
  "use cache";
  return `label-${getRequestContext().get(RequestTenant)}`;
}

// ?via=loader: the read happens in a loader the cached function awaits. The
// loader's value is part of what the function returns, so it refuses the
// same way (it used to be exempt, and the entry stored the tenant it read).
export const TenantLoader = createLoader(
  async (ctx) => `loader-${ctx.get(RequestTenant)}`,
);

async function getTenantLabelViaLoader(ctx: HandlerContext): Promise<string> {
  "use cache";
  return `label-${await ctx.use(TenantLoader)}`;
}

export async function UseCacheNonCacheablePage(ctx: HandlerContext) {
  const label =
    ctx.searchParams.get("via") === "loader"
      ? await getTenantLabelViaLoader(ctx)
      : await getTenantLabel();
  return <p data-testid="use-cache-non-cacheable-value">{label}</p>;
}
