// "use cache" functions for theme-read-guard.rsc-test.tsx (wrapped by
// rangoUseCacheTransform() in vitest.rsc.config.ts). The theme is the
// visitor's cookie and is not in either key, so each read must throw (#971).
import { getRequestContext } from "../../../server/request-context.js";

export async function cachedRequestTheme(): Promise<string> {
  "use cache";
  return `uc-rc-theme-is-${getRequestContext().theme}`;
}

/** Takes the middleware ctx: request-scoped, so it is not in the key. */
export async function cachedCtxTheme(ctx: { theme?: string }): Promise<string> {
  "use cache";
  return `uc-mw-theme-is-${ctx.theme}`;
}
