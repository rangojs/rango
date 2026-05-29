import { env } from "cloudflare:workers";
import { urls, Prerender } from "@rangojs/router";

/**
 * Exercises the `import { env } from "cloudflare:workers"` pattern at
 * build time. Rango's discovery-temp-server stub for `cloudflare:workers`
 * normally exports `env = {}`, but when `buildEnv: "auto"` is configured
 * the stub is populated with the real `getPlatformProxy().env` proxy —
 * so this handler reaches real KV during prerender.
 *
 * Counterpart: `build-env-handler.tsx` exercises the same KV access via
 * the parameter-injected `ctx.env` pattern. Both are supported.
 */
export const BuildEnvDirectPage = Prerender(async () => {
  const kv = (env as { KV: KVNamespace }).KV;
  await kv.put("build-env-direct-test", "seeded-via-cf-workers-import");
  const value = await kv.get("build-env-direct-test");
  return (
    <div data-testid="build-env-direct-page">
      <h1 data-testid="build-env-direct-title">Build Env Direct Test</h1>
      <p data-testid="build-env-direct-value">{value ?? "not-found"}</p>
    </div>
  );
});

export const buildEnvDirectPatterns = urls(({ path }) => [
  path("/", BuildEnvDirectPage, { name: "index" }),
]);
