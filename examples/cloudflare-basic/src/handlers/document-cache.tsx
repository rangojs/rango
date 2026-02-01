import { map, Meta } from "@ivogt/rsc-router/server";
import type { documentCacheRoutes } from "../routes.js";

export default map<typeof documentCacheRoutes>(({ route }) => [
  route("documentCache", (ctx) => {
    const meta = ctx.use(Meta);
    meta({ title: "Document Cache Test - RSC Router" });

    // Opt-in to document caching via Cache-Control header
    ctx.headers.set("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

    const renderTime = new Date().toISOString();

    return (
      <main data-testid="document-cache-page">
        <h1>Document Cache Test</h1>
        <p>Rendered at: {renderTime}</p>
        <p>
          Check response headers for <code>x-document-cache-status</code>
        </p>
      </main>
    );
  }),
]);
