// @vitest-environment happy-dom
/**
 * The optimistic frame of a clientUrls() group under a parameterized
 * include(), in renderRoute's router context with the production
 * mount value: the include PATTERN, as useMount() returns it. renderRoute does
 * not drive clientUrls() navigations (its fidelity contract), so the click's
 * first step, beginClientUrlNavigation, is called as navigation-bridge.ts
 * calls it; what the frame renders goes through the public hooks.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { useMount, useParams, useReverse } from "../../client.js";
import { clientUrls } from "../../client-urls/client-urls.js";
import { ClientUrlsRoot } from "../../client-urls/client-root.js";
import {
  beginClientUrlNavigation,
  clearClientUrlNavigationRegistry,
} from "../../client-urls/navigation.js";
import { renderRoute } from "../render-route.js";

const routes = { index: "/", item: "/items/:itemId" } as const;

function Index(): ReactNode {
  return <p data-testid="index">index</p>;
}

function Item(): ReactNode {
  const params = useParams();
  const reverse = useReverse(routes);
  return (
    <p data-testid="item">
      {useMount()}|{JSON.stringify(params)}|{reverse(".item", { itemId: "7" })}|
      {reverse(".index", { locale: "de" })}
    </p>
  );
}

const shop = clientUrls(({ path }) => [
  path("/", Index, { name: "index" }),
  path("/items/:itemId", Item, { name: "item" }),
]);

function Group(): ReactNode {
  return <ClientUrlsRoot definition={shop} routeId="client-route-0" />;
}

afterEach(() => {
  cleanup();
  clearClientUrlNavigationRegistry();
  window.history.replaceState(null, "", "/");
});

async function clickFrom(
  mount: string,
  origin: string,
  target: string,
): Promise<ReturnType<typeof beginClientUrlNavigation>> {
  window.history.replaceState(null, "", origin);
  await renderRoute([{ path: "/", Component: Group }], {
    mount,
    request: "/",
  });
  let presentation: ReturnType<typeof beginClientUrlNavigation> = null;
  await act(async () => {
    presentation = beginClientUrlNavigation(
      new URL(target, "http://localhost"),
      new AbortController().signal,
    );
  });
  return presentation;
}

describe("clientUrls() frame under include('/:locale')", () => {
  it("renders the destination at the click with the locale in useParams() and useReverse()", async () => {
    const presentation = await clickFrom("/:locale", "/en", "/en/items/42");
    expect(presentation?.routeId).toBe("client-route-1");
    expect(document.querySelector('[data-testid="item"]')?.textContent).toBe(
      '/:locale|{"locale":"en","itemId":"42"}|/en/items/7|/de',
    );
  });

  it("a locale switch is not an in-group click: no frame", async () => {
    expect(await clickFrom("/:locale", "/en", "/de/items/42")).toBeNull();
    expect(document.querySelector('[data-testid="index"]')).not.toBeNull();
  });
});

describe("clientUrls() frame under include('/:locale?')", () => {
  it("renders the destination with and without the prefix", async () => {
    expect((await clickFrom("/:locale?", "/", "/items/42"))?.routeId).toBe(
      "client-route-1",
    );
    expect(document.querySelector('[data-testid="item"]')?.textContent).toBe(
      '/:locale?|{"itemId":"42"}|/items/7|/de',
    );
    cleanup();
    clearClientUrlNavigationRegistry();

    expect((await clickFrom("/:locale?", "/en", "/en/items/42"))?.routeId).toBe(
      "client-route-1",
    );
    expect(document.querySelector('[data-testid="item"]')?.textContent).toBe(
      '/:locale?|{"locale":"en","itemId":"42"}|/en/items/7|/de',
    );
  });
});
