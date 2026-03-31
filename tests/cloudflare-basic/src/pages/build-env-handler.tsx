import { urls, Prerender } from "@rangojs/router";

/**
 * Static Prerender handler (no params) that uses ctx.env.KV at build time.
 * Proves buildEnv threading works end-to-end: rango config -> resolveBuildEnv
 * -> getPlatformProxy -> thread through matchForPrerender -> BuildContext.env.
 */
export const BuildEnvPage = Prerender(async (ctx) => {
  // Write and read KV at build time — proves env is available in BuildContext
  await ctx.env.KV.put("build-env-test", "seeded-at-build-time");
  const value = await ctx.env.KV.get("build-env-test");
  return (
    <div data-testid="build-env-page">
      <h1 data-testid="build-env-title">Build Env Test</h1>
      <p data-testid="build-env-value">{value ?? "not-found"}</p>
      <p data-testid="build-env-build">{String(ctx.build)}</p>
    </div>
  );
});

export const buildEnvPatterns = urls(({ path }) => [
  path("/", BuildEnvPage, { name: "index" }),
]);
