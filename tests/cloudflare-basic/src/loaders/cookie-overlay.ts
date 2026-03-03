import { createLoader } from "@rangojs/router";

export const CookieOverlayLoader = createLoader(async (ctx) => {
  return {
    mwCookie: ctx.cookie("mw-overlay") ?? null,
    actionCookie: ctx.cookie("action-overlay") ?? null,
    deletedCookie: ctx.cookie("to-delete") ?? null,
  };
});
