import { Meta } from "@rangojs/router";
import type { Handler } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { ThemeToggle } from "../components/ThemeToggle.js";
import type { routes } from "./theme.gen.js";

export const ThemeIndexHandler: Handler<"index", routes> = (ctx) => {
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
      <div data-testid="server-theme">
        Server theme: {ctx.theme}
      </div>
      <nav>
        <Link to="/theme/toggle" data-testid="theme-toggle-link">
          Go to Theme Toggle
        </Link>
      </nav>
    </div>
  );
};

export const ThemeToggleHandler: Handler<"toggle", routes> = (ctx) => {
  const meta = ctx.use(Meta);
  meta({ title: "Theme Toggle - RSC Router" });

  return (
    <div data-testid="theme-toggle-page">
      <Link to="/theme" data-testid="back-link">
        ← Back to Theme Index
      </Link>
      <h1 data-testid="theme-toggle-title">Theme Toggle</h1>
      <div data-testid="server-theme">
        Server theme: {ctx.theme}
      </div>
      <ThemeToggle testId="theme-toggle" />
    </div>
  );
};
