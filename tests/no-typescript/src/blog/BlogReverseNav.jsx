"use client";

import { useReverse } from "@rangojs/router/client";
// A plain-JS app importing the GENERATED TypeScript route-types file: Vite
// transpiles the .ts (dropping `as const` and the type export), leaving the
// runtime `routes` map. This is the supported way to drive client-side named
// reverse (useReverse) from a JS app — the file is `rango generate` output.
import { routes } from "./urls.gen.ts";

export function BlogReverseNav() {
  const reverse = useReverse(routes);
  return (
    <div data-testid="blog-reverse">
      <span data-testid="reverse-blog-index">{reverse(".index")}</span>{" "}
      <span data-testid="reverse-blog-post">
        {reverse(".post", { slug: "hello-world" })}
      </span>
    </div>
  );
}
