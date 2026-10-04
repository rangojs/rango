import { getRequestContext, type HandlerContext } from "@rangojs/router";
import { ThemeToggle } from "../components/ThemeToggle.js";

/**
 * ctx.theme on a ppr route (#971), fetched only by ppr-theme.test.ts.
 *
 * - CfPprThemePage reads ctx.theme and CfPprThemeRequestContextPage
 *   getRequestContext().theme: the shell capture refuses, so every request is
 *   a MISS rendered with that visitor's theme.
 * - CfPprThemeClientPage reads the theme with useTheme() instead: it warms to
 *   a HIT whose initialTheme is the no-cookie default, and shows each
 *   visitor's own theme after hydration.
 */
export function CfPprThemePage(ctx: HandlerContext) {
  return (
    <main data-testid="cf-ppr-theme-page">
      <p data-testid="cf-ppr-theme-server">{`ppr-theme-is-${ctx.theme}`}</p>
    </main>
  );
}

export function CfPprThemeRequestContextPage() {
  return (
    <main data-testid="cf-ppr-theme-rc-page">
      <p data-testid="cf-ppr-theme-rc-server">
        {`ppr-rc-theme-is-${getRequestContext().theme}`}
      </p>
    </main>
  );
}

export function CfPprThemeClientPage() {
  return (
    <main data-testid="cf-ppr-theme-client-page">
      <ThemeToggle />
    </main>
  );
}
