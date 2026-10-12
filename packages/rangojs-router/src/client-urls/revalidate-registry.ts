import { toShouldRevalidateFn } from "../router/revalidation.js";
import type { ShouldRevalidateFn } from "../types.js";

/**
 * Hoisted clientUrls() `revalidate()` predicates by content key. The
 * generated `<file>?rango-revalidate` module of a group fills it when the
 * group's module loads in the RSC realm
 * (vite/plugins/client-urls-revalidate-hoist.ts); materialized loader stubs
 * read it (server-projection.ts). A key hashes the file and the predicate's
 * syntax, so a re-registration under one key is the same predicate. A
 * hoisted boolean (`revalidate(FLAG)`) is stored as its constant predicate;
 * any other value is left unregistered for materialization to name.
 *
 * Server-only build output, not router state: no router hook reads it
 * (AGENTS.md Hard rule 8).
 */
const revalidators = new Map<string, ShouldRevalidateFn<any, any>>();

export function registerClientUrlRevalidators(
  fns: Readonly<Record<string, ShouldRevalidateFn<any, any> | boolean>>,
): void {
  for (const [key, fn] of Object.entries(fns)) {
    if (typeof fn === "function" || typeof fn === "boolean") {
      revalidators.set(key, toShouldRevalidateFn(fn));
    } else {
      revalidators.delete(key);
    }
  }
}

export function getClientUrlRevalidator(
  key: string,
): ShouldRevalidateFn<any, any> | undefined {
  return revalidators.get(key);
}

export function clearClientUrlRevalidators(): void {
  revalidators.clear();
}
