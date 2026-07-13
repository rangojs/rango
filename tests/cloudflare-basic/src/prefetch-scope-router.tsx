import { createRouter, urls } from "@rangojs/router";
import { Document } from "./document.js";
import type { AppBindings } from "./env.js";

const urlpatterns = urls(({ path }) => [
  path(
    "/",
    () => (
      <main>
        <h1>Delegated prefetch scope</h1>
        <p>
          <a href="/__prefetch-scope/target" data-testid="prefetch-target">
            In-scope route
          </a>
        </p>
        <p>
          <a
            href="/__prefetch-scope/files/report.pdf"
            data-testid="prefetch-resource"
          >
            Static resource
          </a>
        </p>
        <p>
          <a href="/about" data-testid="prefetch-outside-basename">
            Outside basename
          </a>
        </p>
      </main>
    ),
    { name: "prefetchScopeHome" },
  ),
  path("/target", () => <h1>Prefetch target</h1>, {
    name: "prefetchScopeTarget",
  }),
]);

export const prefetchScopeRouter = createRouter<AppBindings>({
  id: "cloudflare-prefetch-scope",
  basename: "/__prefetch-scope",
  defaultPrefetch: "viewport",
  document: Document,
}).routes(urlpatterns);
