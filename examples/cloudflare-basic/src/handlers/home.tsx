import { map, Meta } from "rsc-router/server";
import type { homeRoutes } from "../routes.js";

export default map<typeof homeRoutes>(({ route }) => [
  route("index", (ctx) => {
    const meta = ctx.use(Meta);
    meta({ charSet: "utf-8" });
    meta({ name: "viewport", content: "width=device-width, initial-scale=1" });
    meta({ title: "Home - RSC Router Cloudflare" });
    meta({ name: "description", content: "A minimal RSC Router example running on Cloudflare Workers" });

    return (
      <main data-testid="home-page">
        <h1 data-testid="home-title">Welcome to RSC Router</h1>
        <p>This is a minimal example running on Cloudflare Workers.</p>
        <p>It demonstrates:</p>
        <ul style={{ marginTop: "1rem", marginLeft: "1.5rem" }}>
          <li>React Server Components with RSC streaming</li>
          <li>Client-side navigation with partial rendering</li>
          <li>Server Actions (see the Counter page)</li>
          <li>Cloudflare Workers deployment</li>
        </ul>
      </main>
    );
  }),
]);
