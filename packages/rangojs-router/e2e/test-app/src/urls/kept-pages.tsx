import type { ReactNode } from "react";
import { Meta, urls, type Handler } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import keptPagesGroup, {
  KeptDriftOutlet,
  KeptPage,
} from "./kept-pages.client.js";

// <Outlet keep /> fixture: /kept-pages/:id under a layout that keeps one
// left page, /kept-pages-group/* a clientUrls() group that keeps one, and
// /kept-pages-drift/:id a layout whose keep differs between server and
// browser. Body: tests/shared-e2e/src/kept-pages-scenario.ts.

function KeptPagesLayout(): ReactNode {
  return (
    <main data-testid="kept-layout">
      <nav>
        {["a", "b", "c"].map((id) => (
          <Link key={id} to={`/kept-pages/${id}`} data-testid={`kept-to-${id}`}>
            {id}
          </Link>
        ))}
      </nav>
      <Outlet keep={{ max: 1 }} />
    </main>
  );
}

const keptPage: Handler<"/kept-pages/:id"> = (ctx) => {
  ctx.use(Meta)({ title: `Kept ${ctx.params.id}` });
  return <KeptPage id={ctx.params.id} />;
};

const keptDriftPage: Handler<"/kept-pages-drift/:id"> = (ctx) => (
  <KeptPage id={ctx.params.id} />
);

export const keptPagesPatterns = urls(({ layout, path, include }) => [
  layout(KeptPagesLayout, () => [
    path("/kept-pages/:id", keptPage, { name: "keptPagesPage" }),
  ]),
  layout(
    () => (
      <main data-testid="kept-drift-layout">
        <KeptDriftOutlet />
      </main>
    ),
    () => [
      path("/kept-pages-drift/:id", keptDriftPage, { name: "keptPagesDrift" }),
    ],
  ),
  include("/kept-pages-group", keptPagesGroup),
]);
