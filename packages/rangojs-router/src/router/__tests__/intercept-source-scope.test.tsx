/**
 * A partial match reports `interceptTargeted` whenever an intercept targets
 * the route, matched or not (issue #1007): whether the intercept applies was
 * decided against the source (its `when` selectors, a same-route navigation),
 * so the response is source-specific even when it renders the full page. The
 * RSC handler turns the flag into `x-rsc-prefetch-scope: source`. A route no
 * intercept targets stays unflagged, keeping the shared prefetch slot.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createRouter } from "../../router.js";
import { buildRouterTrieFromUrlpatterns } from "../../rsc/manifest-init.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";

let router: any;

beforeAll(async () => {
  router = createRouter({} as any);
  router.routes(({ layout, path, intercept }: any) => [
    layout(
      () => <main>root</main>,
      () => [
        path("/", <div>home</div>, { name: "isHome" }),
        path("/elsewhere", <div>elsewhere</div>, { name: "isElsewhere" }),
        path("/item/:id", <div>item</div>, { name: "isItem" }),
        path("/plain/:id", <div>plain</div>, { name: "isPlain" }),
        path("/always/:id", <div>always</div>, { name: "isAlways" }),
        intercept("@modal", "isItem", <dialog>modal</dialog>, {
          when: ({ from }: any) => from.url.pathname === "/",
        }),
        // Routeless host: reached through the orphan walk, not the parent chain.
        layout(
          () => <div>host</div>,
          () => [intercept("@modal", "isAlways", <dialog>always</dialog>)],
        ),
      ],
    ),
  ]);
  await buildRouterTrieFromUrlpatterns(router);
});

async function navigate(pathname: string, from: string) {
  const request = new Request(`https://example.com${pathname}?_rsc_partial`, {
    headers: {
      accept: "text/x-component",
      "X-RSC-Router-Client-Path": `https://example.com${from}`,
    },
  });
  const reqCtx = createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
  } as any);
  const result = await runWithRequestContext(reqCtx, () =>
    router.matchPartial(request, { env: {} }),
  );
  return { intercepted: !!result.slots, targeted: result.interceptTargeted };
}

describe("matchPartial interceptTargeted", () => {
  it("is set when the intercept matched", async () => {
    expect(await navigate("/item/1", "/")).toEqual({
      intercepted: true,
      targeted: true,
    });
  });

  it("is set when the intercept's when() rejected the source", async () => {
    expect(await navigate("/item/1", "/elsewhere")).toEqual({
      intercepted: false,
      targeted: true,
    });
  });

  it("is set on a same-route navigation, which skips the intercept", async () => {
    expect(await navigate("/always/2", "/always/1")).toEqual({
      intercepted: false,
      targeted: true,
    });
    expect(await navigate("/always/2", "/")).toEqual({
      intercepted: true,
      targeted: true,
    });
  });

  it("is unset for a route no intercept targets", async () => {
    expect(await navigate("/plain/1", "/")).toEqual({
      intercepted: false,
      targeted: undefined,
    });
  });
});
