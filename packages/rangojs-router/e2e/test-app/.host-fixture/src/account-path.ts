import type { HandlerContext } from "@rangojs/router";

// One "use cache" function both apps call with their handler ctx. Each app
// names a route `account` at its own path, so what ctx.reverse() returns, and
// with it the cached value, is the calling router's (issue #1065).
export async function accountPath(ctx: HandlerContext): Promise<string> {
  "use cache";
  return ctx.reverse("account");
}
