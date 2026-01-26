import { map, Meta } from "@ivogt/rsc-router/server";
import type { homeRoutes } from "../routes.js";

export default map<typeof homeRoutes>(({ route }) => [
  route("index", (ctx) => {
    const meta = ctx.use(Meta);
    meta({ title: "Home - RSC Router CSP Example" });
    meta({ name: "description", content: "RSC Router example with Content Security Policy (CSP) nonce support" });

    return (
      <main data-testid="home-page">
        <h1 data-testid="home-title">Welcome to RSC Router with CSP</h1>
        <p>This example demonstrates Content Security Policy (CSP) with nonce support.</p>
        <p style={{ marginTop: "1rem" }}>Features:</p>
        <ul style={{ marginTop: "1rem", marginLeft: "1.5rem" }}>
          <li>Auto-generated cryptographic nonce per request</li>
          <li>CSP headers with script-src 'nonce-...' directive</li>
          <li>Inline scripts protected by nonce attribute</li>
          <li>Works with React Server Components streaming</li>
        </ul>
        <p style={{ marginTop: "1rem", fontSize: "0.9rem", color: "#666" }}>
          Open DevTools and check the Response Headers to see the CSP policy.
        </p>
      </main>
    );
  }),
]);
