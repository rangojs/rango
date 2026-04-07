export const interceptIndicatorText = "Intercepted";

export function shouldInterceptProduct(fromPathname: string): boolean {
  return fromPathname === "/";
}
