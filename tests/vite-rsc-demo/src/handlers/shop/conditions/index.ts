/**
 * Intercept conditions for shop routes
 */

interface InterceptConditionParams {
  from: { url: URL };
}

/**
 * Condition for product modal intercept.
 * Only intercept when navigating from non-product pages (e.g., shop index).
 * Don't intercept when already on a product or category page.
 */
export function shouldInterceptProductModal({
  from,
}: InterceptConditionParams): boolean {
  const { pathname } = from.url;
  const shouldIntercept =
    !pathname.startsWith("/shop/products/") &&
    !pathname.startsWith("/shop/product/");
  console.log(
    `[Intercept when] from: ${pathname}, shouldIntercept: ${shouldIntercept}`,
  );
  return shouldIntercept;
}
