"use client";

import { useReverseRoutes, createReverse, Link } from "@rangojs/router/client";
import type { routes } from "../urls/href.gen.js";

/**
 * Client component for testing useReverseRoutes() hook
 * and createReverse() (non-hook usage).
 *
 * Uses concrete routes type from href.gen.ts for full
 * autocomplete and compile-time validation of route names + params.
 */
export function ReverseRoutesTestClient({ routes }: { routes: routes }) {
  const reverse = useReverseRoutes(routes);

  // Hook-based reverse
  const indexUrl = reverse("index");
  const detailUrl = reverse("detail", { id: "42" });

  // Non-hook createReverse (for event handlers, etc.)
  const reverseStatic = createReverse(routes);
  const staticDetailUrl = reverseStatic("detail", { id: "static-99" });

  return (
    <div data-testid="reverse-routes-test">
      <h3>useReverseRoutes hook</h3>
      <ul>
        <li data-testid="reverse-hook-index">
          Index: <code>{indexUrl}</code>
        </li>
        <li data-testid="reverse-hook-detail">
          Detail: <code>{detailUrl}</code>
        </li>
      </ul>

      <h3>createReverse (non-hook)</h3>
      <ul>
        <li data-testid="reverse-static-detail">
          Static detail: <code>{staticDetailUrl}</code>
        </li>
      </ul>

      <h3>Navigation with reversed URLs</h3>
      <div data-testid="reverse-links">
        <Link to={indexUrl} data-testid="reverse-link-index">
          Reverse Index Link
        </Link>
        {" | "}
        <Link to={detailUrl} data-testid="reverse-link-detail">
          Reverse Detail Link
        </Link>
      </div>
    </div>
  );
}
