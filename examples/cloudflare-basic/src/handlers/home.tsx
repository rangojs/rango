import { map } from "rsc-router/server";
import type { homeRoutes } from "../routes.js";

export default map<typeof homeRoutes>(({ route }) => [
  route("index", () => (
    <main>
      <h1>Welcome to RSC Router</h1>
      <p>This is a minimal example running on Cloudflare Workers.</p>
      <p>It demonstrates:</p>
      <ul style={{ marginTop: "1rem", marginLeft: "1.5rem" }}>
        <li>React Server Components with RSC streaming</li>
        <li>Client-side navigation with partial rendering</li>
        <li>Server Actions (see the Counter page)</li>
        <li>Cloudflare Workers deployment</li>
      </ul>
    </main>
  )),
]);
