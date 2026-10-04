// "use cache" functions for identity-read-guard.rsc-test.tsx (wrapped by
// rangoUseCacheTransform() in vitest.rsc.config.ts). Each awaits a loader
// inside the cached body, so the loader's value is stored in the entry,
// whose key does not include what the loader read.
import {
  cookies,
  createLoader,
  createVar,
  type ContextVar,
  type HandlerContext,
} from "../../../index.rsc.js";

/** Set per request by the test router's middleware. */
export const Tenant: ContextVar<string> = createVar<string>({ cache: false });

const TenantLoader = createLoader(async (ctx) => `tenant-${ctx.get(Tenant)}`);

const SessionLoader = createLoader(
  async () => `session-${cookies().get("session")?.value}`,
);

export async function navFromTenant(ctx: HandlerContext): Promise<string> {
  "use cache";
  return `nav:${await ctx.use(TenantLoader)}`;
}

export async function navFromSession(ctx: HandlerContext): Promise<string> {
  "use cache";
  return `nav:${await ctx.use(SessionLoader)}`;
}
