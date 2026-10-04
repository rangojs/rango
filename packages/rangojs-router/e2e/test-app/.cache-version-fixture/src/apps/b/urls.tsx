import { urls } from "@rangojs/router";
import { Nav } from "../../nav.js";

const HEADLINE = "App B v1";

export const urlpatterns = urls(({ path, layout, cache }) => [
  layout(<Nav app="b" />, () => [
    path("/", () => <main data-testid="page">{HEADLINE}</main>, {
      name: "home",
    }),
    path("/one", () => <main data-testid="page">B one</main>, { name: "one" }),
    path("/two", () => <main data-testid="page">B two</main>, { name: "two" }),
    path("/three", () => <main data-testid="page">B three</main>, {
      name: "three",
    }),
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
