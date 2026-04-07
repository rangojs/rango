import { createLoader, cookies } from "@rangojs/router";

export const CookieOverlayLoader = createLoader(async () => {
  const jar = cookies();
  return {
    mwCookie: jar.get("mw-overlay")?.value ?? null,
    actionCookie: jar.get("action-overlay")?.value ?? null,
    deletedCookie: jar.get("to-delete")?.value ?? null,
  };
});
