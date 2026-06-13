import { createLoader, cookies } from "@rangojs/router";

// runLoader accepts either the registered `createLoader()` handle
// (`CookieOverlayLoader` below) or this raw body — the handle's fn is recovered
// from the registry, so exporting the body separately is optional. It is kept
// here only to dogfood both runLoader entry shapes in run-loader.test.ts.
export async function cookieOverlayLoaderBody() {
  const jar = cookies();
  return {
    mwCookie: jar.get("mw-overlay")?.value ?? null,
    actionCookie: jar.get("action-overlay")?.value ?? null,
    deletedCookie: jar.get("to-delete")?.value ?? null,
  };
}

export const CookieOverlayLoader = createLoader(cookieOverlayLoaderBody);
