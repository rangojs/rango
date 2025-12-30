import { map, Meta } from "rsc-router/server";
import type { aboutRoutes } from "../routes.js";

export default map<typeof aboutRoutes>(({ route }) => [
  route("index", (ctx) => {
    const meta = ctx.use(Meta);
    meta({ title: "About - RSC Router CSP Example" });
    meta({ name: "description", content: "Learn about CSP nonce implementation in RSC Router" });
    meta({ property: "og:title", content: "About RSC Router CSP" });

    return (
      <main data-testid="about-page">
        <h1 data-testid="about-title">About CSP Nonce Support</h1>
        <p>
          Content Security Policy (CSP) is a security standard that helps prevent
          cross-site scripting (XSS) and other code injection attacks.
        </p>
        <h2 style={{ marginTop: "1.5rem", marginBottom: "0.5rem" }}>How It Works</h2>
        <ul style={{ marginLeft: "1.5rem" }}>
          <li>A unique nonce is generated for each request</li>
          <li>The nonce is added to all inline script tags</li>
          <li>The CSP header includes the nonce in script-src directive</li>
          <li>Only scripts with matching nonce can execute</li>
        </ul>
        <h2 style={{ marginTop: "1.5rem", marginBottom: "0.5rem" }}>Implementation</h2>
        <pre style={{
          background: "#f5f5f5",
          padding: "1rem",
          borderRadius: "4px",
          overflow: "auto",
          fontSize: "0.85rem"
        }}>
{`createRSCHandler({
  router,
  nonce: () => true, // Auto-generate
});`}
        </pre>
      </main>
    );
  }),
]);
