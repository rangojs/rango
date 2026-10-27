import { Suspense } from "react";
import { urls, type HandlerContext } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { HookFieldsChrome, HookFieldsHold } from "../components/HookFields.js";

/** Every request's server delay. */
const HOOK_FIELDS_DELAY = 400;

/**
 * The page's streamed tail, from the start of its response. Pages 1 to 3:
 * it ends while the client holds the page (HookFieldsHold, 900 ms). Page 4:
 * it keeps the response open past the page's commit.
 */
const tailOf = (id: string): number => (id === "4" ? 1800 : 300);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let renders = 0;

async function HookFieldsTail({ id }: { id: string }) {
  await wait(tailOf(id));
  return <p data-testid="hook-fields-tail">{`tail ${id}`}</p>;
}

function HookFieldsPage(ctx: HandlerContext<{ id: string }>) {
  const { id } = ctx.params;
  return (
    <section data-testid="hook-fields-page">
      <p data-testid="hook-fields-id">{id}</p>
      <HookFieldsHold stamp={`${id}:${++renders}`} />
      {/* A boundary per page: React commits a page with its tail's fallback
          rather than waiting for the tail, as for any new boundary. */}
      <Suspense key={id} fallback={<p data-testid="hook-fields-tail">tail</p>}>
        <HookFieldsTail id={id} />
      </Suspense>
    </section>
  );
}

/**
 * useNavigation()'s fields in every reader shape while React holds a
 * transition() page (e2e hook-fields.test.ts, scenario in
 * tests/shared-e2e/src/hook-fields-scenario.ts). Every request waits
 * HOOK_FIELDS_DELAY; each render of the page brings a new stamp that holds
 * its commit on the client for 900 ms, and a server tail (tailOf) that ends
 * during that hold on pages 1 to 3 and after the commit on page 4.
 */
export const hookFieldsPatterns = urls(
  ({ path, layout, middleware, transition }) => [
    layout(
      () => (
        <div data-testid="hook-fields-shell">
          <HookFieldsChrome />
          <Outlet />
        </div>
      ),
      () => [
        middleware(async (_ctx, next) => {
          await wait(HOOK_FIELDS_DELAY);
          return next();
        }),
        path("/hook-fields/:id", HookFieldsPage, { name: "hookFields" }, () => [
          transition(),
        ]),
      ],
    ),
  ],
);
