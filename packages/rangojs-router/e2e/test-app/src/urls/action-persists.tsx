import { urls, type HandlerContext } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import {
  ActionPersistsChrome,
  ActionPersistsPageReader,
} from "../components/ActionPersists.js";

/** Every request's server delay. */
const ACTION_PERSISTS_DELAY = 300;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function ActionPersistsPage(ctx: HandlerContext<{ id: string }>) {
  const { id } = ctx.params;
  return (
    <section data-testid="action-persists-page" data-page={id}>
      <ActionPersistsPageReader key={id} id={id} />
    </section>
  );
}

function ActionPersistsBoundary() {
  return <p data-testid="action-persists-boundary">save failed</p>;
}

function shell(base: string) {
  return () => (
    <div data-testid="action-persists-shell">
      <ActionPersistsChrome base={base} />
      <Outlet />
    </div>
  );
}

/**
 * useAction() keeps a settled call until the action's next call (rango-t223;
 * e2e action-persists.test.ts, scenario in
 * tests/shared-e2e/src/action-persists-scenario.ts). Pages a and b under a
 * layout whose chrome reads the action; each page mounts a reader of its
 * own. Every request waits ACTION_PERSISTS_DELAY. /action-persists/:id has
 * no transition(); /action-persists-vt/:id has one. A failing call renders
 * the page's errorBoundary() under the layout.
 */
export const actionPersistsPatterns = urls(
  ({ path, layout, middleware, transition, errorBoundary }) => [
    layout(shell("/action-persists"), () => [
      middleware(async (_ctx, next) => {
        await wait(ACTION_PERSISTS_DELAY);
        return next();
      }),
      path(
        "/action-persists/:id",
        ActionPersistsPage,
        { name: "actionPersists" },
        () => [errorBoundary(ActionPersistsBoundary)],
      ),
    ]),
    layout(shell("/action-persists-vt"), () => [
      middleware(async (_ctx, next) => {
        await wait(ACTION_PERSISTS_DELAY);
        return next();
      }),
      path(
        "/action-persists-vt/:id",
        ActionPersistsPage,
        { name: "actionPersistsVt" },
        () => [transition(), errorBoundary(ActionPersistsBoundary)],
      ),
    ]),
  ],
);
