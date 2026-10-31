/**
 * Loaders and predicates of the source-independence fixture
 * (source-independence-router.tsx), outside the "use client" shop module so
 * the server router and the clientUrls() group read the same instances.
 */
import { createLoader } from "../../../index.rsc.js";
import type { LoaderDefinition, ShouldRevalidateFn } from "../../../types.js";

export const templateCategoryId = (
  params: Record<string, string | undefined>,
): string | null => params.category ?? null;

/** The reporter's predicate (#1331). */
export const revalidateCategoryTemplate: ShouldRevalidateFn = ({
  isAction,
  currentParams,
  nextParams,
  defaultShouldRevalidate,
}) => {
  if (isAction()) return false;
  if (templateCategoryId(currentParams) !== templateCategoryId(nextParams)) {
    return true;
  }
  return defaultShouldRevalidate;
};

/** The template's filters slot: shown on a category page only. */
export const filtersOf = (params: Record<string, string | undefined>): string =>
  params.category === undefined ? "off" : "on";

/** The filters slot's predicate: re-render when the slot shows or hides. */
export const revalidateFilters: ShouldRevalidateFn = ({
  currentParams,
  nextParams,
  defaultShouldRevalidate,
}) =>
  filtersOf(currentParams) !== filtersOf(nextParams)
    ? true
    : defaultShouldRevalidate;

/** The deal a category runs: speakers has one, every other page none. */
export const dealOf = (params: Record<string, string | undefined>): string =>
  params.category === "speakers" ? "speakers" : "none";

/** The deal loader's predicate: re-run when the deal changes. */
export const revalidateDeal: ShouldRevalidateFn = ({
  currentParams,
  nextParams,
  defaultShouldRevalidate,
}) =>
  dealOf(currentParams) !== dealOf(nextParams) ? true : defaultShouldRevalidate;

/** The filters slot's loader. */
export const DealLoader: LoaderDefinition<{ deal: string }> = createLoader(
  async (ctx) => ({ deal: `deal:${dealOf(ctx.params)}` }),
);

/** A product page's data: the product and the `?ref=` it was opened with. */
export const ProductLoader: LoaderDefinition<{ product: string }> =
  createLoader(async (ctx) => ({
    product: `product:${ctx.params.productId}:${ctx.searchParams.get("ref") ?? "-"}`,
  }));
