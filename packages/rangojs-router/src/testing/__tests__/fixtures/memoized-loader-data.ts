// "use cache" functions for use-cache-memoized-loader.rsc-test.tsx (wrapped by
// rangoUseCacheTransform() in vitest.rsc.config.ts). Each reads a loader's
// value with ctx.use(); the test decides whether something else started the
// loader first.
import {
  cookies,
  createLoader,
  getRequestContext,
  type HandlerContext,
  type LoaderDefinition,
} from "../../../index.rsc.js";

/** Runs of the cached functions' bodies. */
export const counters: { cachedRuns: number } = { cachedRuns: 0 };

export const UserLoader: LoaderDefinition<string> = createLoader(
  async () => `user-${cookies().get("u")?.value}`,
);

/** Reads UserLoader: its value is built from a cookie another loader read. */
export const ProfileLoader: LoaderDefinition<string> = createLoader(
  async (ctx) => `profile-${await ctx.use(UserLoader)}`,
);

/** Reads no request identity. */
export const PlainLoader: LoaderDefinition<string> = createLoader(
  async () => "plain",
);

/** Reads cookies() in a nested promise, after the loader's value settled. */
export const LateLoader: LoaderDefinition<{ user: Promise<string> }> =
  createLoader(async () => ({
    user: (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return `late-${cookies().get("u")?.value}`;
    })(),
  }));

export async function greetingFor(ctx: HandlerContext): Promise<string> {
  "use cache";
  counters.cachedRuns++;
  return `greeting:${await ctx.use(UserLoader)}`;
}

export async function profileCard(ctx: HandlerContext): Promise<string> {
  "use cache";
  counters.cachedRuns++;
  return `card:${await ctx.use(ProfileLoader)}`;
}

export async function plainGreeting(ctx: HandlerContext): Promise<string> {
  "use cache";
  counters.cachedRuns++;
  return `greeting:${await ctx.use(PlainLoader)}`;
}

export async function lateGreeting(ctx: HandlerContext): Promise<string> {
  "use cache";
  counters.cachedRuns++;
  const { user } = await ctx.use(LateLoader);
  return `greeting:${await user}`;
}

/** Reads UserLoader through the request context's own loader runner. */
export async function requestContextGreeting(): Promise<string> {
  "use cache";
  counters.cachedRuns++;
  return `greeting:${await getRequestContext().use(UserLoader)}`;
}

/** Reads UserLoader without awaiting it. */
export async function fireAndForget(ctx: HandlerContext): Promise<string> {
  "use cache";
  counters.cachedRuns++;
  void ctx.use(UserLoader);
  return "fire";
}
