import { createLoader, cookies } from "@rangojs/router";

// The loader body is exported separately so it can be unit-tested with
// `runLoader(cookieOverlayLoaderBody, ...)` — runLoader takes the RAW async body
// (not the createLoader() handle), since the handle's `$$id` is injected by the
// Vite plugin at build time and is absent in a bare test process.
export async function cookieOverlayLoaderBody() {
  const jar = cookies();
  return {
    mwCookie: jar.get("mw-overlay")?.value ?? null,
    actionCookie: jar.get("action-overlay")?.value ?? null,
    deletedCookie: jar.get("to-delete")?.value ?? null,
  };
}

export const CookieOverlayLoader = createLoader(cookieOverlayLoaderBody);
