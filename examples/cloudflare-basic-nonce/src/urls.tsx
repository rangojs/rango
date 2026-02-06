import { urls } from "@rangojs/router";
import { Meta } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";
import { Counter } from "./components/Counter.js";
import { getCounter } from "./actions/counter.js";

/**
 * Home page component
 */
function HomePage(ctx: HandlerContext) {
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
}

/**
 * About page component
 */
function AboutPage(ctx: HandlerContext) {
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
{`const router = createRouter({
  document: Document,
  nonce: () => true, // Auto-generate
});

// In worker
router.fetch(request, env);`}
      </pre>
    </main>
  );
}

/**
 * Counter page component
 */
async function CounterPage(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "Counter - RSC Router CSP Example" });
  meta({ name: "description", content: "Interactive counter with CSP-protected Server Actions" });

  const initialCount = await getCounter();

  return (
    <main data-testid="counter-page">
      <h1 data-testid="counter-title">Counter Demo with CSP</h1>
      <p style={{ marginBottom: "1rem" }}>
        Server Actions work seamlessly with CSP nonce protection.
      </p>
      <Counter initialCount={initialCount} />
      <div style={{ marginTop: "2rem", color: "#666", fontSize: "0.9rem" }}>
        <p>How it works with CSP:</p>
        <ul style={{ marginLeft: "1.5rem", marginTop: "0.5rem" }}>
          <li>All inline scripts have nonce attributes</li>
          <li>Server Actions are protected by CSP</li>
          <li>RSC streaming payload is nonce-protected</li>
          <li>No 'unsafe-inline' needed for scripts</li>
        </ul>
      </div>
    </main>
  );
}

/**
 * URL patterns - Django-style routing API
 */
export const urlpatterns = urls(({ path }) => [
  path("/", HomePage, { name: "home" }),
  path("/about", AboutPage, { name: "about" }),
  path("/counter", CounterPage, { name: "counter" }),
]);
