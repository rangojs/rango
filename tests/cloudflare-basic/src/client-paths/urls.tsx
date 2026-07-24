import type { ReactNode } from "react";
import { urls } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { MixedClientDetailLoader } from "./loader.js";
import { MixedClientDetail, MixedClientIndex } from "./pages.js";

function MixedRscLayout(): ReactNode {
  return (
    <section data-testid="mixed-rsc-layout">
      <header>
        <h1>RSC layout with client pages</h1>
        <p>
          The route layout is a Server Component; its pages are client
          components.
        </p>
      </header>
      <Outlet />
    </section>
  );
}

export const mixedClientPathPatterns = urls(
  ({ layout, loader, loading, path }) => [
    layout(<MixedRscLayout />, () => [
      path("/mixed-client-routes", () => <MixedClientIndex />, {
        name: "index",
      }),
      path(
        "/mixed-client-routes/:slug",
        () => <MixedClientDetail />,
        { name: "detail" },
        () => [
          loader(MixedClientDetailLoader),
          loading(
            <p data-testid="mixed-client-loading">Loading server data...</p>,
          ),
        ],
      ),
    ]),
  ],
);
