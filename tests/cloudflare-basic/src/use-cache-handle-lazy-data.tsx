import {
  cookies,
  createHandle,
  createLoader,
  type HandlerContext,
} from "@rangojs/router";
import { Suspense, lazy, type ReactElement, type ReactNode } from "react";

/**
 * "use cache" functions for urls.tsx /use-cache-handle-lazy/:shape/:probe.
 * Each pushes lazy state into a handle (a React.lazy, a memoizing thenable,
 * or one a loader it reads pushes) and returns a value whose encode outlasts
 * the handler: a Suspense child that resolves 150 ms later. The pushes are
 * encoded inside the function's guard and the page gets their decoded copy,
 * so the response's render never starts the lazy state with the visitor's
 * session. The entry is keyed by route and URL, not by the cookie.
 */

export const HandleLazyNotes = createHandle<ReactNode>();
export const HandleLazyLabels = createHandle<unknown>();

/** Each block takes the page's ctx, whatever its params. */
type BlockCtx = HandlerContext<any>;

function session(): string {
  return cookies().get("session")?.value ?? "none";
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
  return <b>handle-lazy-slow-leaf</b>;
}

function slowValue(name: string): ReactElement {
  return (
    <section data-testid="handle-lazy-value">
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
    const seen = session();
    return { default: () => <span>{`handle-lazy-session=${seen}`}</span> };
  });
  ctx.use(HandleLazyNotes)(<Lazy />);
  return slowValue("handle-lazy-component");
}

async function thenableBlock(ctx: BlockCtx): Promise<ReactElement> {
  "use cache";
  ctx.use(HandleLazyLabels)(
    memoThenable(async () => `handle-thenable-session=${session()}`),
  );
  return slowValue("handle-lazy-thenable");
}

// Exported: the loader transform registers exported createLoader declarations.
export const HandleLazyThenableLoader = createLoader(async (ctx) => {
  ctx.use(HandleLazyLabels)(
    memoThenable(async () => `handle-loader-session=${session()}`),
  );
  return "handle-lazy-loader-thenable";
});

async function loaderThenableBlock(ctx: BlockCtx): Promise<ReactElement> {
  "use cache";
  return slowValue(await ctx.use(HandleLazyThenableLoader));
}

const blocks = {
  "lazy-component": lazyComponentBlock,
  thenable: thenableBlock,
  "loader-thenable": loaderThenableBlock,
};

export async function HandleLazyPage(
  ctx: HandlerContext<{ shape: string; probe: string }>,
): Promise<ReactElement> {
  const block = blocks[ctx.params.shape as keyof typeof blocks];
  return <main data-testid="handle-lazy-page">{await block(ctx)}</main>;
}
