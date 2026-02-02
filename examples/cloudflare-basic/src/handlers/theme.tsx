import { map } from "@ivogt/rsc-router/server";
import { Link } from "@ivogt/rsc-router/client";
import type { themeRoutes } from "../routes.js";
import { RootLayout } from "../components/SlowRootLayout.js";
import { ThemeToggle } from "../components/ThemeToggle.js";

export default map<typeof themeRoutes>(({ route, layout }) => [
  layout(<RootLayout />, () => [
    route("theme", (ctx) => (
      <div className="theme-page">
        <h1>Theme Demo</h1>
        <p>
          This page demonstrates the theme system with <code>useTheme</code>{" "}
          hook and server-side <code>ctx.theme</code>.
        </p>

        <div className="server-info">
          <h2>Server-Side Theme</h2>
          <p>
            Current theme from server: <strong>{ctx.theme}</strong>
          </p>
          <p className="note">
            The server reads the theme from cookies to avoid flash of unstyled
            content (FOUC).
          </p>
        </div>

        <div className="client-info">
          <h2>Client-Side Theme Toggle</h2>
          <ThemeToggle />
        </div>

        <div className="features">
          <h2>Features</h2>
          <ul>
            <li>
              <strong>No FOUC</strong> - Theme is applied before paint via
              inline script
            </li>
            <li>
              <strong>System detection</strong> - Automatically detects{" "}
              <code>prefers-color-scheme</code>
            </li>
            <li>
              <strong>Persistence</strong> - Theme saved in localStorage and
              cookies
            </li>
            <li>
              <strong>SSR support</strong> - Server reads theme from cookies
            </li>
            <li>
              <strong>Cross-tab sync</strong> - Theme changes sync across tabs
            </li>
          </ul>
        </div>

        <Link to="/">Back to Home</Link>

        <style
          dangerouslySetInnerHTML={{
            __html: `
              .theme-page h1 {
                margin-bottom: 1rem;
              }
              .theme-page h2 {
                margin: 1.5rem 0 0.5rem;
                font-size: 1.25rem;
              }
              .server-info, .client-info, .features {
                padding: 1rem;
                margin: 1rem 0;
                border: 1px solid var(--border-color, #eee);
                border-radius: 8px;
              }
              .note {
                font-size: 0.875rem;
                color: #666;
                font-style: italic;
              }
              .features ul {
                margin-left: 1.5rem;
              }
              .features li {
                margin: 0.5rem 0;
              }
              code {
                background: #f0f0f0;
                padding: 0.125rem 0.25rem;
                border-radius: 4px;
                font-size: 0.875rem;
              }

              /* Dark mode styles */
              .dark .server-info,
              .dark .client-info,
              .dark .features {
                border-color: #444;
              }
              .dark .note {
                color: #999;
              }
              .dark code {
                background: #333;
              }
            `,
          }}
        />
      </div>
    )),
  ]),
]);
