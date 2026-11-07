// "use cache" functions for use-cache-handle-lazy.rsc-test.tsx (wrapped by
// rangoUseCacheTransform() in vitest.rsc.config.ts). Each creates lazy state
// in its body (a React.lazy, a memoizing thenable), pushes it into a handle,
// and returns a value whose encode outlasts the handler: a Suspense child
// that resolves later.
import { Suspense, lazy, type ReactElement, type ReactNode } from "react";
import {
  cookies,
  createHandle,
  createLoader,
  type Handle,
  type HandlerContext,
  type LoaderDefinition,
} from "../../../index.rsc.js";

export const state: { starts: number } = { starts: 0 };

/** Each block takes its route's ctx, whatever its params. */
type BlockCtx = HandlerContext<any>;

export const LazyNotes: Handle<ReactNode> = createHandle<ReactNode>(
  undefined,
  "test#LazyNotes",
);

export const LazyLabels: Handle<unknown> = createHandle<unknown>(
  undefined,
  "test#LazyLabels",
);

function visitor(): string {
  return cookies().get("session")?.value ?? "none";
}

/**
 * A thenable that starts `start` on its first then() call and memoizes it,
 * so whoever calls then() first decides its value for every later caller.
 */
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
  return <b>slow-leaf</b>;
}

/** The value: its root row is at once, its Suspense child 150 ms later. */
function slowValue(name: string): ReactElement {
  return (
    <section>
      <i>{name}</i>
      <Suspense fallback={<i>waiting</i>}>
        <SlowLeaf />
      </Suspense>
    </section>
  );
}

/** A React.lazy component, pushed as an element. */
export async function LazyComponentBlock(ctx: BlockCtx): Promise<ReactElement> {
  "use cache";
  const Lazy = lazy(async () => {
    state.starts += 1;
    const seen = visitor();
    return { default: () => <span>{`lazy=${seen}`}</span> };
  });
  ctx.use(LazyNotes)(<Lazy />);
  return slowValue("lazy-component-block");
}

/** A memoizing thenable, pushed as the handle value. */
export async function ThenableBlock(ctx: BlockCtx): Promise<ReactElement> {
  "use cache";
  ctx.use(LazyLabels)(
    memoThenable(async () => {
      state.starts += 1;
      return `thenable=${visitor()}`;
    }),
  );
  return slowValue("thenable-block");
}

/** A memoizing thenable, nested in the pushed object. */
export async function NestedThenableBlock(
  ctx: BlockCtx,
): Promise<ReactElement> {
  "use cache";
  ctx.use(LazyLabels)({
    label: memoThenable(async () => {
      state.starts += 1;
      return `nested=${visitor()}`;
    }),
  });
  return slowValue("nested-thenable-block");
}

/** Pushes a memoizing thenable from a loader's body. */
export const ThenableLoader: LoaderDefinition<string> = createLoader(
  async (ctx) => {
    ctx.use(LazyLabels)(
      memoThenable(async () => {
        state.starts += 1;
        return `loader=${visitor()}`;
      }),
    );
    return "loader-thenable-block";
  },
);

/** Reads ThenableLoader, so its run and its pushes are the execution's. */
export async function LoaderThenableBlock(
  ctx: BlockCtx,
): Promise<ReactElement> {
  "use cache";
  return slowValue(await ctx.use(ThenableLoader));
}

/** Pushes a plain value from a loader's body. */
export const PlainPushLoader: LoaderDefinition<string> = createLoader(
  async (ctx) => {
    ctx.use(LazyLabels)("plain-loader-push");
    return "plain-loader";
  },
);

/** The same shapes reading nothing request-scoped: stored and replayed. */
export async function PlainLazyBlock(ctx: BlockCtx): Promise<ReactElement> {
  "use cache";
  await ctx.use(PlainPushLoader);
  const Lazy = lazy(async () => {
    state.starts += 1;
    return { default: () => <span>plain-lazy</span> };
  });
  ctx.use(LazyNotes)(<Lazy />);
  ctx.use(LazyLabels)(
    memoThenable(async () => {
      state.starts += 1;
      return "plain-thenable";
    }),
  );
  return slowValue("plain-lazy-block");
}

/** Pushes from its body; read only through NestingLoader. */
export const NestedPushLoader: LoaderDefinition<string> = createLoader(
  async (ctx) => {
    ctx.use(LazyLabels)("nested-loader-push");
    return "nested";
  },
);

/** Reads NestedPushLoader, so its push is made inside both bodies. */
export const NestingLoader: LoaderDefinition<string> = createLoader(
  async (ctx) => `nesting-${await ctx.use(NestedPushLoader)}`,
);

/** Reads NestingLoader. */
export async function NestedLoaderBlock(ctx: BlockCtx): Promise<string> {
  "use cache";
  return ctx.use(NestingLoader);
}

/** Pushes between the handler's own pushes. */
export async function MiddleBlock(ctx: BlockCtx): Promise<string> {
  "use cache";
  ctx.use(LazyLabels)("label-middle");
  return "middle-block";
}
