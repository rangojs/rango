import { createLoader, createVar, cookies } from "@rangojs/router";

export const NonCacheableData = createVar<string>({ cache: false });

// Sync read — reads non-cacheable var before any await
export const NonCacheableReaderLoader = createLoader(async (ctx) => {
  "use server";
  const session = ctx.get(NonCacheableData);
  return { session: session ?? "no-session" };
});

// Async read — reads non-cacheable var AFTER an await boundary.
// Tests that the exemption survives async suspension.
export const AsyncNonCacheableReaderLoader = createLoader(async (ctx) => {
  "use server";
  // Simulate async work before reading
  await new Promise((resolve) => setTimeout(resolve, 10));
  const session = ctx.get(NonCacheableData);
  return { session: session ?? "no-session-async" };
});

// Response-level side effect — calls cookies().set() inside a cache() boundary.
// Tests that the loader scope bypass covers setCookie, not just ctx.get().
export const CookieWriterLoader = createLoader(async () => {
  "use server";
  await new Promise((resolve) => setTimeout(resolve, 10));
  const jar = cookies();
  jar.set("csg-loader-cookie", "written-by-loader", { path: "/" });
  return { wrote: true };
});

// Reads cookies() inside a loader within a cache() boundary — ALLOWED.
// Loaders always run fresh, so reading request-scoped data is safe: the
// purity guard (isInsideCacheScope) returns false inside loader scope.
export const CookieReaderLoader = createLoader(async () => {
  "use server";
  await new Promise((resolve) => setTimeout(resolve, 10));
  const session = cookies().get("csg-session")?.value;
  return { session: session ?? "no-cookie" };
});
