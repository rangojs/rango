"use client";

import { useReverseRoutes, Link } from "@rangojs/router/client";

/**
 * Client component demonstrating useReverseRoutes() hook.
 * Generic over TRoutes — the narrow const type flows through
 * from the server component that passes the routes prop.
 */
export function ReverseRoutesDemo<
  TRoutes extends Record<string, string>,
>({ routes }: { routes: TRoutes }) {
  const reverse = useReverseRoutes(routes);

  const indexUrl = reverse("index");
  const detailUrl = reverse("detail", { slug: "getting-started" });

  return (
    <div data-testid="reverse-routes-demo">
      <h3>Client-side useReverseRoutes</h3>
      <ul>
        <li data-testid="reverse-demo-index">
          Articles index: <code>{indexUrl}</code>
        </li>
        <li data-testid="reverse-demo-detail">
          Article detail: <code>{detailUrl}</code>
        </li>
      </ul>
      <div data-testid="reverse-demo-links">
        <Link to={indexUrl} data-testid="reverse-demo-link-index">
          Go to Articles
        </Link>
        {" | "}
        <Link to={detailUrl} data-testid="reverse-demo-link-detail">
          Go to Article
        </Link>
      </div>
    </div>
  );
}
