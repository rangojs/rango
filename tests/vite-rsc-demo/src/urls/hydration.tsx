import { urls, Meta } from "@rangojs/router";
import { HydrationNotes } from "../handles/hydration-notes.js";
import { LateNoteLoader } from "../loaders/hydration-demo.js";
import {
  HydrationIndexPage,
  HydrationLayout,
  HydrationOtherPage,
  LateHandlePage,
  LateStatePage,
} from "../pages/hydration-demo.js";

/** Hydration from the stream: see pages/hydration-demo.tsx. */
export const hydrationPatterns = urls(({ path, layout, loader, loading }) => [
  layout(
    (ctx) => {
      ctx.use(Meta)({ title: "Hydration" });
      ctx.use(HydrationNotes)("layout note");
      return <HydrationLayout />;
    },
    () => [
      path("/", HydrationIndexPage, { name: "index" }),
      path(
        "/late-handle",
        (ctx) => {
          ctx.use(HydrationNotes)("route note");
          return <LateHandlePage />;
        },
        { name: "lateHandle" },
        () => [
          loader(LateNoteLoader),
          loading(<p data-testid="hyd-loading">Loading the late note</p>),
        ],
      ),
      path(
        "/late-state",
        (ctx) => (
          <LateStatePage
            delay={Number(ctx.searchParams.get("delay") ?? 1200)}
          />
        ),
        { name: "lateState" },
      ),
      path(
        "/other",
        (ctx) => {
          ctx.use(HydrationNotes)("other page note");
          return <HydrationOtherPage />;
        },
        { name: "other" },
      ),
    ],
  ),
]);
