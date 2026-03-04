import type { HandlerContext } from "@rangojs/router";
import { CookieOverlayLoader } from "../loaders/cookie-overlay.js";
import { CookieOverlayTest } from "../components/CookieOverlayTest.js";

export async function CookieOverlayPage(ctx: HandlerContext) {
  const data = await ctx.use(CookieOverlayLoader);

  return (
    <main data-testid="cookie-overlay-page">
      <h1>Cookie Overlay Test</h1>
      <CookieOverlayTest
        mwCookie={data.mwCookie}
        actionCookie={data.actionCookie}
        deletedCookie={data.deletedCookie}
      />
    </main>
  );
}
