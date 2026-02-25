/**
 * Intercept conditions for shop routes
 */

interface InterceptConditionParams {
  from: { pathname: string };
}

/**
 * Condition for product modal intercept.
 * Only intercept when navigating from non-product pages (e.g., shop index).
 * Don't intercept when already on a product or category page.
 */
export function shouldInterceptProductModal({
  from,
}: InterceptConditionParams): boolean {
  const shouldIntercept =
    !from.pathname.startsWith("/shop/products/") &&
    !from.pathname.startsWith("/shop/product/");
  console.log(
    `[Intercept when] from: ${from.pathname}, shouldIntercept: ${shouldIntercept}`,
  );
  return shouldIntercept;
}
