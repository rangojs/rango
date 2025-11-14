import { map, layout, middleware, redirect } from "rsc-router";
import type { protectedRoutes } from "../routes.js";
import { RootLayout } from "../layouts/RootLayout.js";

/**
 * Protected handlers - demonstrates middleware short-circuit & system param filtering
 *
 * KEY FEATURES DEMONSTRATED:
 * 1. Soft redirects (SPA navigation) via redirect() helper
 * 2. Hard redirects (full page reload) via Response.redirect()
 * 3. Transparent system params (handlers don't see _rsc* params)
 * 4. Error handling in middleware
 * 5. Early Response returns (short-circuit pipeline)
 */
export default map<typeof protectedRoutes>({
  // Global layout
  [layout("*", "root")]: <RootLayout />,

  // ===================================================
  // MIDDLEWARE - Demonstrates Short-Circuit Patterns
  // ===================================================

  // Auth middleware - demonstrates SOFT redirect (SPA navigation)
  [middleware("*", "auth")]: [
    (ctx, next) => {
      const user = ctx.get("user");

      // NOTE: In real app, user would be set by previous middleware
      // For demo, we check if ?logged_in=true query param exists
      const isLoggedIn = ctx.searchParams.get("logged_in") === "true";

      if (!isLoggedIn) {
        console.log("[Protected] No user - soft redirect to /");
        // SOFT REDIRECT: SPA navigation (client fetches / as partial)
        return redirect("/");
      }

      console.log("[Protected] User authenticated - continuing");
      next();
    },
  ],

  // Rate limit middleware - demonstrates HARD redirect (full page reload)
  [middleware("dashboard", "rateLimit")]: [
    (ctx, next) => {
      // Check if exceeded rate limit
      const rateLimited = ctx.searchParams.get("rate_limited") === "true";

      if (rateLimited) {
        console.log("[Protected] Rate limited - hard redirect (full reload)");
        // HARD REDIRECT: Full page reload
        return Response.redirect("/", 302);
      }

      next();
    },
  ],

  // Error handling middleware - demonstrates try/catch
  [middleware("profile", "errorHandler")]: [
    async (ctx, next) => {
      try {
        await next(); // Execute remaining middleware + handler
      } catch (error) {
        console.error("[Protected] Middleware caught error:", error);
        // Could return error Response here
        throw error; // Re-throw for now
      }
    },
  ],

  // ===================================================
  // ROUTE HANDLERS
  // ===================================================

  index: (ctx) => (
    <div>
      <h2>Protected Area</h2>
      <p className="segment-id">Segment: Protected Index</p>

      <div style={{
        background: "#d1ecf1",
        padding: "1rem",
        borderRadius: "8px",
        marginTop: "1rem",
        border: "2px solid #0c5460",
      }}>
        <h3 style={{ marginTop: 0 }}>🔐 Features Demonstrated:</h3>
        <ul style={{ lineHeight: 1.8 }}>
          <li>
            <strong>Soft Redirects:</strong> Middleware uses <code>redirect()</code> for SPA navigation
          </li>
          <li>
            <strong>Transparent URLs:</strong> Handlers don't see <code>_rsc*</code> system params
          </li>
          <li>
            <strong>Error Handling:</strong> Middleware has try/catch support
          </li>
          <li>
            <strong>Short-Circuit:</strong> Middleware can return Response to skip handler
          </li>
        </ul>
      </div>

      <div style={{
        background: "#fff3cd",
        padding: "1rem",
        borderRadius: "8px",
        marginTop: "1rem",
        border: "2px solid #856404",
      }}>
        <h3 style={{ marginTop: 0 }}>📋 System Param Filtering Test:</h3>
        <p style={{ margin: "0.5rem 0" }}>
          <strong>Your current URL:</strong> <code>{ctx.url.href}</code>
        </p>
        <p style={{ margin: "0.5rem 0" }}>
          <strong>Query params visible to handler:</strong>
        </p>
        <ul>
          {ctx.searchParams.toString().length > 0 ? (
            ctx.searchParams.toString().split('&').map((param) => {
              const [key, value] = param.split('=');
              return (
                <li key={key}>
                  <code>{key}={value}</code>
                </li>
              );
            })
          ) : (
            <li><em>No query params (clean!)</em></li>
          )}
        </ul>
        <p style={{
          fontSize: "0.85rem",
          color: "#856404",
          marginTop: "0.75rem",
          marginBottom: 0
        }}>
          ℹ️ System params like <code>_rsc_segments</code> are filtered out.
          Access raw request via <code>ctx._originalRequest</code>
        </p>
      </div>

      <h3>Test Middleware Short-Circuit:</h3>
      <ul>
        <li>
          <a href="/protected/dashboard">Dashboard</a> (auth passes → renders)
        </li>
        <li>
          <a href="/protected/dashboard?rate_limited=true">Dashboard (rate limited)</a> (hard redirect → full reload)
        </li>
        <li>
          <a href="/protected/profile/alice">Profile (alice)</a> (auth passes → renders)
        </li>
      </ul>

      <p style={{ marginTop: "2rem" }}>
        <a href="/">← Back to Home</a>
      </p>
    </div>
  ),

  dashboard: (ctx) => (
    <div>
      <h2>Dashboard</h2>
      <p className="segment-id">Segment: Protected Dashboard</p>
      <p>Server render time: {new Date().toISOString()}</p>

      <div style={{
        background: "#d4edda",
        padding: "1rem",
        borderRadius: "8px",
        marginTop: "1rem",
        border: "2px solid #155724",
      }}>
        <p style={{ margin: 0, color: "#155724" }}>
          ✅ Auth middleware passed - you're logged in!
        </p>
      </div>

      <div style={{
        background: "#fff3cd",
        padding: "1rem",
        borderRadius: "8px",
        marginTop: "1rem",
      }}>
        <h3 style={{ marginTop: 0 }}>Test Rate Limiting:</h3>
        <ul>
          <li>
            <a href="/protected/dashboard">Normal request</a> (works)
          </li>
          <li>
            <a href="/protected/dashboard?rate_limited=true">Trigger rate limit</a> (hard redirect)
          </li>
        </ul>
      </div>

      <p><a href="/protected">← Back to Protected</a></p>
    </div>
  ),

  profile: (ctx) => (
    <div>
      <h2>Profile: {ctx.params.username}</h2>
      <p className="segment-id">Segment: Profile ({ctx.params.username})</p>
      <p>Server render time: {new Date().toISOString()}</p>

      <div style={{
        background: "#fff3cd",
        padding: "1rem",
        borderRadius: "8px",
        marginTop: "1rem",
      }}>
        <h3 style={{ marginTop: 0 }}>URL Transparency Test:</h3>
        <p>Current URL seen by handler:</p>
        <code style={{
          display: "block",
          background: "#f8f9fa",
          padding: "0.5rem",
          borderRadius: "4px",
          marginTop: "0.5rem",
        }}>
          {ctx.url.href}
        </code>
        <p style={{ fontSize: "0.9rem", marginTop: "0.75rem", color: "#666" }}>
          ℹ️ System params (_rsc*) are filtered. This URL matches what you see in the browser.
        </p>
      </div>

      <p><a href="/protected">← Back to Protected</a></p>
    </div>
  ),
});
