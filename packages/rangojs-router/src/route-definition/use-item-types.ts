import type { AllUseItems, WhenItem } from "../route-types.js";

/**
 * The set of valid use-item `type` discriminants — the single runtime source of
 * truth for "is this a well-formed use item?" shape validation.
 *
 * Declared via a `Record<...>` so that adding a member to the union without
 * updating this map is a compile error. `when` is included because when() items
 * are valid inside intercept() even though WhenItem is not part of AllUseItems
 * (it lives only in InterceptUseItem). This is shape validation only; per-mount-
 * site rules remain the narrower hand-written tables in resolve-handler-use.ts.
 */
const USE_ITEM_TYPES: Record<AllUseItems["type"] | WhenItem["type"], true> = {
  layout: true,
  route: true,
  middleware: true,
  revalidate: true,
  parallel: true,
  intercept: true,
  loader: true,
  loading: true,
  errorBoundary: true,
  notFoundBoundary: true,
  when: true,
  cache: true,
  transition: true,
  include: true,
};

export const ALL_USE_ITEM_TYPES: ReadonlySet<string> = new Set(
  Object.keys(USE_ITEM_TYPES),
);
