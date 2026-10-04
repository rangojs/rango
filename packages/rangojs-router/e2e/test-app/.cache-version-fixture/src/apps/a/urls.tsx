import { urls } from "@rangojs/router";
import { Nav } from "../../nav.js";

// The text the suite edits to make a server-only change to this app.
const HEADLINE = "App A v1";

export const urlpatterns = urls(({ path, layout, cache }) => [
  layout(<Nav app="a" />, () => [
    path("/", () => <main data-testid="page">{HEADLINE}</main>, {
      name: "home",
    }),
    path("/one", () => <main data-testid="page">A one</main>, { name: "one" }),
    path("/two", () => <main data-testid="page">A two</main>, { name: "two" }),
    path("/three", () => <main data-testid="page">A three</main>, {
      name: "three",
    }),
    // The stamp is rendered inside the boundary, so the same number on a later
    // request means the segment cache served the stored entry.
    cache({ ttl: 600 }, () => [
      path(
        "/cached",
        () => (
          <main data-testid="page">
            <p data-testid="stamp">{Date.now()}</p>
          </main>
        ),
        { name: "cached" },
      ),
    ]),
    // Stored HTML: the stamp is frozen into the PPR shell's prelude, so the
    // same number with `x-rango-shell: HIT` means the stored shell was served.
    path(
      "/shell",
      () => (
        <main data-testid="page">
          <p data-testid="shell-stamp">{Date.now()}</p>
        </main>
      ),
      { name: "shell", ppr: { ttl: 600 } },
    ),
  ]),
]);
