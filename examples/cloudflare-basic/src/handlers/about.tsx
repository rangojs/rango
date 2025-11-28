import { map } from "rsc-router/server";
import type { aboutRoutes } from "../routes.js";
import { RootLayout } from "../components/RootLayout.js";

export default map<typeof aboutRoutes>(({ route, layout }) => [
  layout(<RootLayout />),

  route("index", () => (
    <main>
      <h1>About</h1>
      <p>
        RSC Router is a code-first, type-safe router for React Server
        Components.
      </p>
      <p style={{ marginTop: "1rem" }}>
        Built for serverless deployments like Cloudflare Workers, it provides:
      </p>
      <ul style={{ marginTop: "1rem", marginLeft: "1.5rem" }}>
        <li>Nested routes with layout composition</li>
        <li>Type-safe params extraction</li>
        <li>Partial rendering optimization</li>
        <li>Server Actions with automatic revalidation</li>
        <li>Middleware support</li>
      </ul>
    </main>
  )),
]);
