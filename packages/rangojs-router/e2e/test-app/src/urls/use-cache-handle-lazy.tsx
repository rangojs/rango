import { Suspense, lazy, type ReactElement, type ReactNode } from "react";
import {
  urls,
  cookies,
  createHandle,
  createLoader,
  type HandlerContext,
} from "@rangojs/router";

/**
 * A "use cache" function pushes lazy state it creates (a React.lazy, a
 * memoizing thenable), or a loader it reads pushes one, into a handle, and
 * returns a value whose encode outlasts the handler (a Suspense child that
 * resolves 150 ms later). Fetched by e2e/use-cache-handle-lazy.test.ts. The
 * pushes are encoded inside the function's guard and the page gets their
 * decoded copy, so the lazy state's cookies() read refuses and visitor a's
 * cookie is never stored for visitor b. The entry is keyed by route and URL
 * (`probe`), not by the cookie.
 *
 * - /lazy-component, /thenable, /loader-thenable: read the visitor cookie.
 * - /plain: the same shapes reading nothing request-scoped, stored and
 *   replayed on the next request.
 */

export const UchlNotes = createHandle<ReactNode>();
export const UchlLabels = createHandle<unknown>();

/** Each block takes the page's ctx, whatever its params. */
type BlockCtx = HandlerContext<any>;

function visitor(): string {
  return cookies().get("visitor")?.value ?? "none";
}

/** Starts `start` on its first then() call and memoizes it. */
function memoThenable<T>(start: () => Promise<T>): PromiseLike<T> {
  let started: Promise<T> | undefined;
  return {
    then(onFulfilled, onRejected) {
      started ??= start();
      return started.then(onFulfilled, onRejected);
    },
  };
}

async function SlowLeaf(): Promise<ReactElement> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  return <b>uchl-slow-leaf</b>;
}

function slowValue(name: string): ReactElement {
  return (
    <section data-testid="uchl-value">
      <i>{name}</i>
      <Suspense fallback={<i>waiting</i>}>
        <SlowLeaf />
      </Suspense>
    </section>
  );
}

async function lazyComponentBlock(ctx: BlockCtx): Promise<ReactElement> {
  "use cache";
  const Lazy = lazy(async () => {
    const seen = visitor();
    return { default: () => <span>{`uchl-lazy=${seen}`}</span> };
  });
  ctx.use(UchlNotes)(<Lazy />);
  return slowValue("uchl-lazy-component");
}

async function thenableBlock(ctx: BlockCtx): Promise<ReactElement> {
  "use cache";
  ctx.use(UchlLabels)(memoThenable(async () => `uchl-thenable=${visitor()}`));
  return slowValue("uchl-thenable");
}

// Exported: the loader transform registers exported createLoader declarations.
export const UchlThenableLoader = createLoader(async (ctx) => {
  ctx.use(UchlLabels)(memoThenable(async () => `uchl-loader=${visitor()}`));
  return "uchl-loader-thenable";
});

async function loaderThenableBlock(ctx: BlockCtx): Promise<ReactElement> {
  "use cache";
  return slowValue(await ctx.use(UchlThenableLoader));
}

async function plainBlock(ctx: BlockCtx): Promise<ReactElement> {
  "use cache";
  const Lazy = lazy(async () => ({
    default: () => <span>uchl-plain-lazy</span>,
  }));
  ctx.use(UchlNotes)(<Lazy />);
  ctx.use(UchlLabels)(memoThenable(async () => "uchl-plain-thenable"));
  return slowValue(`uchl-plain@${Date.now()}-${Math.random()}`);
}

const blocks = {
  "lazy-component": lazyComponentBlock,
  thenable: thenableBlock,
  "loader-thenable": loaderThenableBlock,
  plain: plainBlock,
};

async function HandleLazyPage(ctx: HandlerContext<{ shape: string }>) {
  const block = blocks[ctx.params.shape as keyof typeof blocks];
  return <main data-testid="uchl-page">{await block(ctx)}</main>;
}

export const useCacheHandleLazyPatterns = urls(({ path }) => [
  path("/:shape", HandleLazyPage, { name: "shape" }),
]);
