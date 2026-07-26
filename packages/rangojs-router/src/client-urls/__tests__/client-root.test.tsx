// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { type ReactNode } from "react";
import { Outlet, useOutlet } from "../../client.js";
import { MountContextProvider } from "../../browser/react/mount-context.js";
import { OutletProvider } from "../../outlet-provider.js";
import type { LoaderDefinition } from "../../types.js";
import { useLoader } from "../../use-loader.js";
import {
  ClientUrlsGroupLayout,
  ClientUrlsInterceptLoading,
  ClientUrlsInterceptSlot,
  ClientUrlsLoading,
  ClientUrlsRoot,
} from "../client-root.js";
import { clientUrls } from "../client-urls.js";
import {
  beginClientUrlNavigation,
  clearClientUrlNavigationRegistry,
  collectClientRevalidationDecisions,
  registerClientUrlGroup,
  setActiveInterceptTargets,
} from "../navigation.js";
import { decodeClientRevalidationDecisions } from "../revalidation-protocol.js";

afterEach(() => {
  cleanup();
  clearClientUrlNavigationRegistry();
});

describe("ClientUrlsRoot", () => {
  it("renders nested layout outlets while retaining outer loader context", () => {
    const AccountLoader = {
      __brand: "loader",
      $$id: "loaders/account#AccountLoader",
    } as LoaderDefinition<{ name: string }>;

    function AppLayout(): ReactNode {
      return (
        <main data-testid="app-layout">
          <Outlet />
        </main>
      );
    }

    function AccountLayout(): ReactNode {
      return (
        <section data-testid="account-layout">
          <Outlet />
        </section>
      );
    }

    function AccountPage(): ReactNode {
      const { data } = useLoader(AccountLoader);
      return <p data-testid="account-page">{data.name}</p>;
    }

    const definition = clientUrls(({ layout, path }) => [
      layout(AppLayout, () => [
        layout(AccountLayout, () => [path("/account", AccountPage)]),
      ]),
    ]);

    const result = render(
      <OutletProvider
        content={null}
        loaderData={{ [AccountLoader.$$id]: { name: "Ada" } }}
      >
        <ClientUrlsRoot definition={definition} routeId="client-route-0" />
      </OutletProvider>,
    );

    const app = result.getByTestId("app-layout");
    const account = result.getByTestId("account-layout");
    const page = result.getByTestId("account-page");
    expect(app.contains(account)).toBe(true);
    expect(account.contains(page)).toBe(true);
    expect(page.textContent).toBe("Ada");
  });

  it("renders a route directly when it has no layouts", () => {
    function HomePage(): ReactNode {
      return <p data-testid="home">Home</p>;
    }

    const definition = clientUrls(({ path }) => [path("/", HomePage)]);
    const result = render(
      <ClientUrlsRoot definition={definition} routeId="client-route-0" />,
    );

    expect(result.getByTestId("home").textContent).toBe("Home");
  });

  it("throws a clear error when the route id and definition do not match", () => {
    function HomePage(): null {
      return null;
    }

    const definition = clientUrls(({ path }) => [path("/", HomePage)]);

    expect(() =>
      render(
        <ClientUrlsRoot definition={definition} routeId="client-route-9" />,
      ),
    ).toThrow(
      'Client URL route mismatch: route id "client-route-9" was not found in the provided definition',
    );
  });

  it("renders destination loading and scopes pending to its layouts", async () => {
    function AppLayout(): ReactNode {
      const outlet = useOutlet();
      return (
        <main data-pending={String(outlet.pending)}>{outlet.content}</main>
      );
    }

    function HomePage(): ReactNode {
      return <p>Home</p>;
    }

    function AccountPage(): ReactNode {
      return <p>Account</p>;
    }

    const definition = clientUrls(({ layout, path, loading }) => [
      layout(AppLayout, () => [
        path("/", HomePage),
        path("/account", AccountPage, () => [loading(<p>Loading account</p>)]),
      ]),
    ]);
    const result = render(
      <ClientUrlsRoot definition={definition} routeId="client-route-0" />,
    );
    const abort = new AbortController();

    const presentation: {
      current: ReturnType<typeof beginClientUrlNavigation>;
    } = { current: null };
    await act(async () => {
      presentation.current = beginClientUrlNavigation(
        new URL("http://localhost/account"),
        abort.signal,
      );
    });

    expect(presentation.current?.routeId).toBe("client-route-1");
    expect(result.getByText("Loading account")).toBeDefined();
    expect(result.container.querySelector("main")?.dataset.pending).toBe(
      "true",
    );

    await act(async () => presentation.current?.clear());
    expect(result.getByText("Home")).toBeDefined();
    expect(result.container.querySelector("main")?.dataset.pending).toBe(
      "false",
    );
  });

  it("signals pending on a same-route intent without presenting loading", async () => {
    function AppLayout(): ReactNode {
      const outlet = useOutlet();
      return (
        <main data-pending={String(outlet.pending)}>{outlet.content}</main>
      );
    }

    function HomePage(): ReactNode {
      return <p>Home</p>;
    }

    // The route HAS a loading() node — the stronger pin: a same-route intent
    // (filter/search nav) must keep the current content, never swap to the
    // route's own loading, while still reporting pending to the layouts.
    const definition = clientUrls(({ layout, path, loading }) => [
      layout(AppLayout, () => [
        path("/", HomePage, () => [loading(<p>Loading home</p>)]),
      ]),
    ]);
    const result = render(
      <ClientUrlsRoot definition={definition} routeId="client-route-0" />,
    );
    const abort = new AbortController();

    const presentation: {
      current: ReturnType<typeof beginClientUrlNavigation>;
    } = { current: null };
    await act(async () => {
      presentation.current = beginClientUrlNavigation(
        new URL("http://localhost/?category=electronics"),
        abort.signal,
      );
    });

    expect(presentation.current?.routeId).toBe("client-route-0");
    expect(result.getByText("Home")).toBeDefined();
    expect(result.queryByText("Loading home")).toBeNull();
    expect(result.container.querySelector("main")?.dataset.pending).toBe(
      "true",
    );

    await act(async () => presentation.current?.clear());
    expect(result.getByText("Home")).toBeDefined();
    expect(result.container.querySelector("main")?.dataset.pending).toBe(
      "false",
    );
  });

  it("matches mount-relative patterns under the include() prefix and ignores outside paths", async () => {
    function AppLayout(): ReactNode {
      const outlet = useOutlet();
      return (
        <main data-pending={String(outlet.pending)}>{outlet.content}</main>
      );
    }

    function IndexPage(): ReactNode {
      return <p>Index</p>;
    }

    function DetailPage(): ReactNode {
      return <p>Detail</p>;
    }

    // Patterns are definition-LOCAL; the include() mount ("/catalog", read via
    // useMount) is stripped from the navigated pathname before matching.
    const definition = clientUrls(({ layout, path, loading }) => [
      layout(AppLayout, () => [
        path("/", IndexPage),
        path("/:productId", DetailPage, () => [loading(<p>Loading detail</p>)]),
      ]),
    ]);
    const result = render(
      <MountContextProvider value="/catalog">
        <ClientUrlsRoot definition={definition} routeId="client-route-0" />
      </MountContextProvider>,
    );
    const abort = new AbortController();

    // A navigation OUTSIDE the mount gets no optimistic presentation.
    let outside: ReturnType<typeof beginClientUrlNavigation> = null;
    await act(async () => {
      outside = beginClientUrlNavigation(
        new URL("http://localhost/elsewhere/espresso"),
        abort.signal,
      );
    });
    expect(outside).toBeNull();
    expect(result.container.querySelector("main")?.dataset.pending).toBe(
      "false",
    );

    // Inside the mount, the local pathname "/espresso" matches the detail
    // route and presents its loading state.
    const presentation: {
      current: ReturnType<typeof beginClientUrlNavigation>;
    } = { current: null };
    await act(async () => {
      presentation.current = beginClientUrlNavigation(
        new URL("http://localhost/catalog/espresso"),
        abort.signal,
      );
    });
    expect(presentation.current?.routeId).toBe("client-route-1");
    expect(result.getByText("Loading detail")).toBeDefined();
    expect(result.container.querySelector("main")?.dataset.pending).toBe(
      "true",
    );

    // The bare mount is the module index.
    await act(async () => presentation.current?.clear());
    let bare: ReturnType<typeof beginClientUrlNavigation> = null;
    await act(async () => {
      bare = beginClientUrlNavigation(
        new URL("http://localhost/catalog"),
        abort.signal,
      );
    });
    expect((bare as ReturnType<typeof beginClientUrlNavigation>)?.routeId).toBe(
      "client-route-0",
    );
  });

  it("treats a falsy loading node as configured destination loading", async () => {
    function AppLayout(): ReactNode {
      const outlet = useOutlet();
      return (
        <main data-pending={String(outlet.pending)}>{outlet.content}</main>
      );
    }

    function HomePage(): ReactNode {
      return <p>Home</p>;
    }

    function AccountPage(): ReactNode {
      return <p>Account</p>;
    }

    // Presence must follow the projection's hasLoading (`!== undefined`), not
    // truthiness: loading("") is a configured empty loading state, so the
    // current branch must be replaced, not retained.
    const definition = clientUrls(({ layout, path, loading }) => [
      layout(AppLayout, () => [
        path("/", HomePage),
        path("/account", AccountPage, () => [loading("")]),
      ]),
    ]);
    const result = render(
      <ClientUrlsRoot definition={definition} routeId="client-route-0" />,
    );
    const abort = new AbortController();

    await act(async () => {
      beginClientUrlNavigation(
        new URL("http://localhost/account"),
        abort.signal,
      );
    });

    expect(result.queryByText("Home")).toBeNull();
    expect(result.container.querySelector("main")?.dataset.pending).toBe(
      "true",
    );
  });
});

describe("intercept coordination", () => {
  function Page(): null {
    return null;
  }

  it("declines the optimistic presentation for intercept-claimed targets", () => {
    const definition = clientUrls(({ path }) => [
      path("/", Page, { name: "index" }),
      path("/items/:itemId", Page, { name: "item" }),
    ]);
    const intents: Array<unknown> = [];
    registerClientUrlGroup(
      definition,
      "/client-urls-intercept",
      "clientIntercept",
      (intent) => intents.push(intent),
    );
    setActiveInterceptTargets(["clientIntercept.item"]);
    const abort = new AbortController();

    // The canonical name (namePrefix + local name) is claimed: no intent, no
    // presentation — the canonical response will commit the modal instead.
    const claimed = beginClientUrlNavigation(
      new URL("http://localhost/client-urls-intercept/items/alpha"),
      abort.signal,
    );
    expect(claimed).toBeNull();
    expect(intents).toEqual([]);

    // A non-claimed sibling route in the same group still presents.
    const allowed = beginClientUrlNavigation(
      new URL("http://localhost/client-urls-intercept"),
      abort.signal,
    );
    expect(allowed?.routeId).toBe("client-route-0");
  });

  it("clears the target set with the registry and treats missing metadata as empty", () => {
    const definition = clientUrls(({ path }) => [
      path("/items/:itemId", Page, { name: "item" }),
    ]);
    registerClientUrlGroup(definition, "/", "", () => {});
    setActiveInterceptTargets(["item"]);
    clearClientUrlNavigationRegistry();

    registerClientUrlGroup(definition, "/", "", () => {});
    setActiveInterceptTargets(undefined);
    const abort = new AbortController();
    const presentation = beginClientUrlNavigation(
      new URL("http://localhost/items/alpha"),
      abort.signal,
    );
    expect(presentation?.routeId).toBe("client-route-0");
  });
});

describe("client-declared intercept rendering", () => {
  function DetailPage(): null {
    return null;
  }

  function DetailModal(): ReactNode {
    return <p data-testid="detail-modal">Modal</p>;
  }

  const definition = clientUrls(({ path, intercept, loading }) => [
    path("/detail/:id", DetailPage, { name: "detail" }),
    intercept("@modal", ".detail", DetailModal, () => [
      loading(<p data-testid="modal-loading">Loading modal</p>),
    ]),
  ]);

  it("renders the intercept component and loading node by index", () => {
    const result = render(
      <ClientUrlsInterceptSlot definition={definition} interceptIndex={0} />,
    );
    expect(result.getByTestId("detail-modal").textContent).toBe("Modal");

    const loadingNode = ClientUrlsInterceptLoading({
      definition,
      interceptIndex: 0,
    });
    const loadingResult = render(<>{loadingNode}</>);
    expect(loadingResult.getByTestId("modal-loading")).toBeDefined();
  });

  it("throws a clear mismatch error for an unknown intercept index", () => {
    expect(() =>
      render(
        <ClientUrlsInterceptSlot definition={definition} interceptIndex={3} />,
      ),
    ).toThrow(
      "Client URL intercept mismatch: intercept index 3 was not found in the provided definition",
    );
    expect(() =>
      ClientUrlsInterceptLoading({ definition, interceptIndex: 3 }),
    ).toThrow(
      "Client URL intercept mismatch: intercept index 3 was not found in the provided definition",
    );
  });

  it("renders child and slot outlets from the group layout", () => {
    const slotSegment = {
      id: "test.slot",
      slot: "@modal",
      component: <p data-testid="group-slot">Slot</p>,
    } as unknown as import("../../types.js").ResolvedSegment;
    const result = render(
      <OutletProvider
        content={<p data-testid="group-child">Child</p>}
        parallel={[slotSegment]}
      >
        <ClientUrlsGroupLayout slotNames={["@modal"]} />
      </OutletProvider>,
    );
    expect(result.getByTestId("group-child")).toBeDefined();
    expect(result.getByTestId("group-slot")).toBeDefined();
  });
});

describe("client revalidation decisions", () => {
  function Page(): null {
    return null;
  }

  const SessionLoader = {
    __brand: "loader",
    $$id: "loaders#session",
  } as LoaderDefinition<unknown>;
  const ItemLoader = {
    __brand: "loader",
    $$id: "loaders#item",
  } as LoaderDefinition<unknown>;

  it("runs per-loader predicates on the held route and encodes only non-default verdicts", () => {
    // Session skips action revalidation; item follows defaults (no predicate).
    const definition = clientUrls(({ path, loader, revalidate }) => [
      path("/items/:itemId", Page, { name: "item" }, () => [
        loader(SessionLoader, () => [
          revalidate(({ isAction, defaultShouldRevalidate }) =>
            isAction ? false : defaultShouldRevalidate,
          ),
        ]),
        loader(ItemLoader),
      ]),
    ]);
    registerClientUrlGroup(definition, "/shop", "shop", () => {});

    // Action on the held route: default true, session predicate says false.
    const action = collectClientRevalidationDecisions({
      currentUrl: new URL("http://localhost/shop/items/a"),
      nextUrl: new URL("http://localhost/shop/items/a"),
      isAction: true,
      actionId: "actions#bump",
      stale: false,
    });
    expect(decodeClientRevalidationDecisions(action)).toEqual({
      skip: ["loaders#session"],
      force: [],
    });

    // Same-route param nav: default true (params changed), predicate returns
    // the default — every verdict matches, so no header at all.
    const paramNav = collectClientRevalidationDecisions({
      currentUrl: new URL("http://localhost/shop/items/a"),
      nextUrl: new URL("http://localhost/shop/items/b"),
      isAction: false,
      stale: false,
    });
    expect(paramNav).toBeNull();
  });

  it("supports forcing revalidation against a false default (stale restores)", () => {
    const definition = clientUrls(({ path, loader, revalidate }) => [
      path("/", Page, { name: "index" }, () => [
        loader(SessionLoader, () => [
          revalidate(({ stale, defaultShouldRevalidate }) =>
            stale ? true : defaultShouldRevalidate,
          ),
        ]),
      ]),
    ]);
    registerClientUrlGroup(definition, "/", "", () => {});

    const decisions = collectClientRevalidationDecisions({
      currentUrl: new URL("http://localhost/"),
      nextUrl: new URL("http://localhost/"),
      isAction: false,
      stale: true,
    });
    expect(decodeClientRevalidationDecisions(decisions)).toEqual({
      skip: [],
      force: ["loaders#session"],
    });
  });

  it("returns null without an active group or off-mount current location", () => {
    expect(
      collectClientRevalidationDecisions({
        currentUrl: new URL("http://localhost/anywhere"),
        nextUrl: new URL("http://localhost/anywhere"),
        isAction: true,
        stale: false,
      }),
    ).toBeNull();

    const definition = clientUrls(({ path, loader, revalidate }) => [
      path("/", Page, { name: "index" }, () => [
        loader(SessionLoader, () => [revalidate(() => false)]),
      ]),
    ]);
    registerClientUrlGroup(definition, "/shop", "shop", () => {});
    expect(
      collectClientRevalidationDecisions({
        currentUrl: new URL("http://localhost/elsewhere"),
        nextUrl: new URL("http://localhost/shop"),
        isAction: false,
        stale: false,
      }),
    ).toBeNull();
  });

  it("fails open to the default when a predicate throws", () => {
    const definition = clientUrls(({ path, loader, revalidate }) => [
      path("/", Page, { name: "index" }, () => [
        loader(SessionLoader, () => [
          revalidate(() => {
            throw new Error("boom");
          }),
        ]),
      ]),
    ]);
    registerClientUrlGroup(definition, "/", "", () => {});

    // Action default is true; the throwing predicate keeps it — no header.
    expect(
      collectClientRevalidationDecisions({
        currentUrl: new URL("http://localhost/"),
        nextUrl: new URL("http://localhost/"),
        isAction: true,
        stale: false,
      }),
    ).toBeNull();
  });
});

describe("ClientUrlsLoading", () => {
  it("returns the route loading node or null", () => {
    function HomePage(): null {
      return null;
    }

    function AboutPage(): null {
      return null;
    }

    const loading = <span>Loading home</span>;
    const definition = clientUrls(({ path, loading: useLoading }) => [
      path("/", HomePage, () => [useLoading(loading)]),
      path("/about", AboutPage),
    ]);

    expect(ClientUrlsLoading({ definition, routeId: "client-route-0" })).toBe(
      loading,
    );
    expect(
      ClientUrlsLoading({ definition, routeId: "client-route-1" }),
    ).toBeNull();
  });

  it("throws the same mismatch error for an unknown route id", () => {
    function HomePage(): null {
      return null;
    }

    const definition = clientUrls(({ path }) => [path("/", HomePage)]);

    expect(() =>
      ClientUrlsLoading({ definition, routeId: "missing-route" }),
    ).toThrow(
      'Client URL route mismatch: route id "missing-route" was not found in the provided definition',
    );
  });
});
