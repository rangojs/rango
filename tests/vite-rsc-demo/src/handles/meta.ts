import { createHandle } from "@rangojs/router";

export interface MetaData {
  title: string;
}

/**
 * Meta handle — page title (and future meta tags). Deepest segment wins:
 * the collect takes the LAST pushed entry in segment order, so a product
 * page's title overrides its layout's.
 *
 * Written from loaders via `ctx.use(Meta)({ title })` (client-shop) — async
 * by the race model: a push that beats the handler barrier is in the SSR
 * handle snapshot; a later one streams and TitleUpdater applies it
 * post-hydration.
 */
export const Meta = createHandle<MetaData, MetaData | undefined>((segments) =>
  segments.flat().at(-1),
);
