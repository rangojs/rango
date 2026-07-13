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
            href="/__prefetch-scope#hash-target"
            data-testid="prefetch-hash-only"
          >
            Same-page hash
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
          <a
            href="/__prefetch-scope/target.js"
            data-prefetch="true"
            data-testid="prefetch-resource-route"
          >
            Static-looking application route
          </a>
        </p>
        <p>
          <a
            href="/__prefetch-scope/promo/50%off"
            data-prefetch="true"
            data-testid="prefetch-malformed-route"
          >
            Malformed-percent application route
          </a>
        </p>
        <p>
          <a
            href="/__prefetch-scope/logout"
            data-prefetch="none"
            data-testid="prefetch-none"
          >
            Unsafe GET opt-out
          </a>
        </p>
        <section data-prefetch-scope="none">
          <a
            href="/__prefetch-scope/target?container-scope=none"
            data-prefetch="true"
            data-testid="prefetch-container-scope-none"
          >
            Container-scoped target
          </a>
        </section>
        <p>
          <a
            href="/about"
            data-prefetch="true"
            data-testid="prefetch-outside-basename"
          >
            Outside basename
          </a>
        </p>
        <p>
          <a
            href="/__prefetch-scope%2Fadmin"
            data-prefetch="true"
            data-testid="prefetch-encoded-separator"
          >
            Encoded separator outside basename
          </a>
        </p>
        <svg aria-label="SVG link fixture">
          <a href="/__prefetch-scope/svg-target" data-testid="prefetch-svg">
            <circle cx="5" cy="5" r="5" />
          </a>
        </svg>
        <div id="hash-target">Hash target</div>
      </main>
    ),
    { name: "prefetchScopeHome" },
  ),
  path("/target", () => <h1>Prefetch target</h1>, {
    name: "prefetchScopeTarget",
  }),
  path("/target.js", () => <h1>Static-looking prefetch target</h1>, {
    name: "prefetchScopeResourceRoute",
  }),
]);

export const prefetchScopeRouter = createRouter<AppBindings>({
  id: "cloudflare-prefetch-scope",
  basename: "/__prefetch-scope",
  defaultPrefetch: "viewport",
  document: Document,
}).routes(urlpatterns);
