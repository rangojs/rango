import { cookies, urls } from "@rangojs/router";

/**
 * Cache isolation test fixture.
 *
 * Proves that cached responses do not leak across:
 *   - query string variants
 *   - auth states (with custom key function)
 *   - request-scoped cookies/headers (onResponse freshness)
 *
 * All cached routes embed Date.now() so timestamps prove hit vs miss.
 */
export const cacheIsolationPatterns = urls(({ path, cache }) => [
  // Query-isolated: same path, different ?v= must get separate cache entries.
  cache({ ttl: 600 }, () => [
    path.json(
      "/query-variant",
      (ctx) => ({
        variant: ctx.searchParams.get("v") ?? "default",
        ts: Date.now(),
      }),
      { name: "queryVariant" },
    ),
  ]),

  // Auth-keyed cache: uses custom key() to include auth state.
  // Authenticated and unauthenticated requests MUST get separate entries.
  cache(
    {
      ttl: 600,
      key: (ctx) => {
        const token = cookies().get("iso-token")?.value;
        return `auth-${token ? "authed" : "anon"}:${ctx.pathname}`;
      },
    },
    () => [
      path.json(
        "/auth-keyed",
        () => {
          const token = cookies().get("iso-token")?.value;
          return {
            user: token ? "authenticated" : "anonymous",
            secret: token ? "classified-data" : null,
            ts: Date.now(),
          };
        },
        { name: "authKeyed" },
      ),
    ],
  ),

  // No-auth-key cache: default key does NOT include auth state.
  // Proves that without custom key, both auth states share the cache entry.
  cache({ ttl: 600 }, () => [
    path.json(
      "/no-auth-key",
      () => {
        const token = cookies().get("iso-token")?.value;
        return {
          user: token ? "authenticated" : "anonymous",
          ts: Date.now(),
        };
      },
      { name: "noAuthKey" },
    ),
  ]),

  // Condition-gated cache: skips cache when auth cookie is present.
  // Proves condition() prevents cache read/write for specific requests.
  cache(
    {
      ttl: 600,
      condition: (ctx) => {
        return !cookies().get("iso-token")?.value;
      },
    },
    () => [
      path.json(
        "/condition-gated",
        () => {
          const token = cookies().get("iso-token")?.value;
          return {
            user: token ? "authenticated" : "anonymous",
            ts: Date.now(),
          };
        },
        { name: "conditionGated" },
      ),
    ],
  ),
]);
