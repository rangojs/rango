/**
 * Stub for `@vitejs/plugin-rsc/browser`, shipped so consumers do not have to
 * write a per-file `vi.mock(...)`. The real entry imports the
 * `virtual:vite-rsc/client-references` Vite virtual at the top level, which a
 * bare Vitest process cannot resolve.
 *
 * The router reaches this module from `useLoader().load()` and a
 * `refreshGroup` refresh (use-loader.tsx imports deps/browser.ts lazily).
 * renderRoute answers those requests (render-route.tsx), and a DOM test has
 * no Flight server to encode an answer: renderRoute's seeds are client values
 * already. So the answer travels with its Response object, and
 * `createFromFetch` hands it back unchanged, as a decoded payload. Any other
 * response is rejected. The remaining exports exist for the re-export in
 * deps/browser.ts; navigations, actions and the document are not decoded
 * here.
 */

const answers = new WeakMap<object, unknown>();

/**
 * A loader endpoint Response whose decoded payload is `payload`
 * (`{ loaderResult }` or `{ loaderResult: null, loaderError }`, as
 * rsc/loader-fetch.ts answers).
 */
export function loaderAnswerResponse(payload: {
  loaderResult: unknown;
  loaderError?: { message: string; name: string };
}): Response {
  const response = new Response(null, {
    headers: { "content-type": "text/x-component" },
  });
  answers.set(response, payload);
  return response;
}

export async function createFromFetch<T>(
  response: Promise<Response> | Response,
): Promise<T> {
  const settled = await response;
  if (!answers.has(settled)) {
    throw new Error(
      "@vitejs/plugin-rsc/browser test stub: createFromFetch decodes only " +
        "the loader answers renderRoute gives (useLoader().load(), a " +
        "refreshGroup refresh). Real Flight responses are e2e territory.",
    );
  }
  return answers.get(settled) as T;
}

function unavailable(name: string): never {
  throw new Error(
    `@vitejs/plugin-rsc/browser test stub: ${name} is not available in a ` +
      "bare Vitest process. Real Flight responses are e2e territory.",
  );
}

export const createFromReadableStream = (): Promise<never> =>
  unavailable("createFromReadableStream");
export const encodeReply = (): Promise<never> => unavailable("encodeReply");
export const setServerCallback = (): void => {};
export const createTemporaryReferenceSet = (): unknown => new Map();
