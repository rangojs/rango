import { createVar, getRequestContext, type Middleware } from "@rangojs/router";

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

export async function UseCacheNonCacheablePage() {
  const label = await getTenantLabel();
  return <p data-testid="use-cache-non-cacheable-value">{label}</p>;
}
