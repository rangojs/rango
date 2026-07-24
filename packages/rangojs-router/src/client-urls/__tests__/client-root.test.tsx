// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { type ReactNode } from "react";
import { Outlet, useOutlet } from "../../client.js";
import { OutletProvider } from "../../outlet-provider.js";
import type { LoaderDefinition } from "../../types.js";
import { useLoader } from "../../use-loader.js";
import { ClientUrlsLoading, ClientUrlsRoot } from "../client-root.js";
import { clientUrls } from "../client-urls.js";
import {
  beginClientUrlNavigation,
  clearClientUrlNavigationRegistry,
} from "../navigation.js";

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
