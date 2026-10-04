import { Meta, getRequestContext } from "@rangojs/router";
import type { Handler } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { ThemeToggle } from "../components/ThemeToggle.js";

export const ThemeIndexHandler: Handler<"theme.index"> = (ctx) => {
  const meta = ctx.use(Meta);
  meta({ title: "Theme Test - RSC Router" });

  return (
    <div data-testid="theme-index-page">
      <Link to="/" data-testid="back-link">
        ← Back to Home
      </Link>
      <h1 data-testid="theme-title">Theme Test</h1>
      <p data-testid="theme-description">
        Tests theme functionality including ctx.theme and ctx.setTheme
      </p>
      <div data-testid="server-theme">Server theme: {ctx.theme}</div>
      <nav>
        <Link to="/theme/toggle" data-testid="theme-toggle-link">
          Go to Theme Toggle
        </Link>
      </nav>
    </div>
  );
};

export const ThemeToggleHandler: Handler<"theme.toggle"> = (ctx) => {
  const meta = ctx.use(Meta);
  meta({ title: "Theme Toggle - RSC Router" });

  return (
    <div data-testid="theme-toggle-page">
      <Link to="/theme" data-testid="back-link">
        ← Back to Theme Index
      </Link>
      <h1 data-testid="theme-toggle-title">Theme Toggle</h1>
      <div data-testid="server-theme">Server theme: {ctx.theme}</div>
      <ThemeToggle testId="theme-toggle" />
    </div>
  );
};

export const ThemePprHandler: Handler<"theme.ppr"> = (ctx) => (
  <div data-testid="theme-ppr-page">
    <div data-testid="theme-ppr-server">{`ppr-theme-is-${ctx.theme}`}</div>
  </div>
);

export const ThemePprRequestContextHandler: Handler<"theme.pprRc"> = () => (
  <div data-testid="theme-ppr-rc-page">
    <div data-testid="theme-ppr-rc-server">
      {`ppr-rc-theme-is-${getRequestContext().theme}`}
    </div>
  </div>
);

// A server component handed the whole ctx: in dev, React serializes its props
// for debug info, which must not count as a ctx.theme read.
function ThemePprChrome({ ctx }: { ctx: { pathname: string } }) {
  return <p data-testid="theme-ppr-client-path">{ctx.pathname}</p>;
}

export const ThemePprClientHandler: Handler<"theme.pprClient"> = (ctx) => (
  <div data-testid="theme-ppr-client-page">
    <ThemePprChrome ctx={ctx} />
    <ThemeToggle testId="theme-ppr-client" />
  </div>
);

export const ThemeDocCacheHandler: Handler<"theme.docCache"> = (ctx) => {
  ctx.headers.set("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  return (
    <div data-testid="theme-doc-cache-page">
      <ThemeToggle testId="theme-doc-cache" />
    </div>
  );
};

export const ThemeDocCacheLiveHandler: Handler<"theme.docCacheLive"> = () => (
  <div data-testid="theme-doc-cache-live-page">
    <ThemeToggle testId="theme-doc-cache-live" />
  </div>
);
