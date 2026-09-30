// "use cache" functions for request-raw-reads.rsc-test.tsx (wrapped by
// rangoUseCacheTransform() in vitest.rsc.config.ts). A ctx or a Request
// argument is keyed by the route and URL only, never by its headers (#976).
import type { HandlerContext } from "../../../index.rsc.js";

let calls = 0;

/** Reads a request header inside the body: not in the key, so it throws. */
export async function cachedVisitorFromHeaders(
  ctx: HandlerContext,
): Promise<string> {
  "use cache";
  return `uc-visitor-is-${ctx.request.headers.get("x-visitor")}`;
}

/** The fix: the header is read by the caller and keys the entry. */
export async function cachedVisitor(visitor: string | null): Promise<string> {
  "use cache";
  calls += 1;
  return `uc-arg-visitor-is-${visitor}-call-${calls}`;
}

/** Takes the Request itself: keyed by its URL, and the body reads no header. */
export async function cachedRequestPath(request: Request): Promise<string> {
  "use cache";
  return `uc-path-is-${new URL(request.url).pathname}`;
}
