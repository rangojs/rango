// @vitest-environment happy-dom
/**
 * The optimistic frame of a clientUrls() group under a server layout whose
 * revalidate() reads the destination (a category hero on category pages,
 * re-rendered when the category changes), in renderRoute's router context.
 * The server ships what that rule read as ClientUrlsRoot's `chrome` prop
 * (client-urls-chrome-reads.rsc-test.tsx); a destination that changes it gets
 * no frame, so the committed page stays until the canonical commit instead
 * of the destination showing under the committed page's hero. renderRoute
 * does not drive clientUrls() navigations (its fidelity contract), so the
 * click's first step, beginClientUrlNavigation, is called as
 * navigation-bridge.ts calls it; what the group renders goes through the
 * public hooks.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { useParams } from "../../client.js";
import { clientUrls } from "../../client-urls/client-urls.js";
import { ClientUrlsRoot } from "../../client-urls/client-root.js";
import type { ChromeReads } from "../../client-urls/chrome-reads.js";
import {
  beginClientUrlNavigation,
  clearClientUrlNavigationRegistry,
} from "../../client-urls/navigation.js";
import { renderRoute } from "../render-route.js";

function Plp(): ReactNode {
  return <p data-testid="page">{`plp:${useParams().category}`}</p>;
}
function Product(): ReactNode {
  return <p data-testid="page">{`product:${useParams().productId}`}</p>;
}
function Cart(): ReactNode {
  return <p data-testid="page">cart</p>;
}

const shop = clientUrls(({ path }) => [
  path("/c/:category", Plp),
  path("/p/:productId", Product),
  path("/cart", Cart),
]);

const ROUTE_ID = {
  "/c/:category": "client-route-0",
  "/p/:productId": "client-route-1",
  "/cart": "client-route-2",
} as const;

afterEach(() => {
  cleanup();
  clearClientUrlNavigationRegistry();
  window.history.replaceState(null, "", "/");
});

const page = (): string | null | undefined =>
  document.querySelector('[data-testid="page"]')?.textContent;

/** Open `origin` (a page of `route`) with the server's `chrome`. */
async function open(
  origin: string,
  route: keyof typeof ROUTE_ID,
  chrome: ChromeReads | undefined,
): Promise<void> {
  window.history.replaceState(null, "", origin);
  function Group(): ReactNode {
    return (
      <ClientUrlsRoot
        definition={shop}
        routeId={ROUTE_ID[route]}
        chrome={chrome}
      />
    );
  }
  await renderRoute([{ path: route, Component: Group }], { request: origin });
}

async function click(
  target: string,
): Promise<ReturnType<typeof beginClientUrlNavigation>> {
  let presentation: ReturnType<typeof beginClientUrlNavigation> = null;
  await act(async () => {
    presentation = beginClientUrlNavigation(
      new URL(target, "http://localhost"),
      new AbortController().signal,
    );
  });
  return presentation;
}

// What the template's rule read on each page.
const onCategory: ChromeReads = { params: { category: "audio" } };
const offCategory: ChromeReads = { params: { category: null } };

describe("clientUrls() frame under chrome a revalidate() reads", () => {
  it("a product clicked on a category page: no frame, the category page stays", async () => {
    await open("/c/audio", "/c/:category", onCategory);
    expect(page()).toBe("plp:audio");
    expect(await click("/p/1")).toBeNull();
    expect(page()).toBe("plp:audio");
    expect(await click("/cart")).toBeNull();
    expect(page()).toBe("plp:audio");
  });

  it("a click that keeps what the rule read presents at once", async () => {
    await open("/p/1", "/p/:productId", offCategory);
    expect((await click("/cart"))?.routeId).toBe(ROUTE_ID["/cart"]);
    expect(page()).toBe("cart");
  });

  it("a category clicked on a product page: no frame", async () => {
    await open("/p/1", "/p/:productId", offCategory);
    expect(await click("/c/audio")).toBeNull();
    expect(page()).toBe("product:1");
  });

  it("from a frame, against the committed page's chrome", async () => {
    await open("/p/1", "/p/:productId", offCategory);
    expect((await click("/cart"))?.routeId).toBe(ROUTE_ID["/cart"]);
    expect(page()).toBe("cart");
    // The chrome on screen is still product 1's: a category changes it.
    expect(await click("/c/audio")).toBeNull();
    expect((await click("/p/2"))?.routeId).toBe(ROUTE_ID["/p/:productId"]);
    expect(page()).toBe("product:2");
  });

  it("a same-route click swaps nothing and keeps its pending intent", async () => {
    await open("/c/audio", "/c/:category", onCategory);
    expect((await click("/c/video"))?.routeId).toBe(ROUTE_ID["/c/:category"]);
    expect(page()).toBe("plp:audio");
  });

  it("any: no cross-route frame", async () => {
    await open("/p/1", "/p/:productId", "any");
    expect(await click("/cart")).toBeNull();
    expect(page()).toBe("product:1");
  });

  it("no chrome reads: every frame (control)", async () => {
    await open("/c/audio", "/c/:category", undefined);
    expect((await click("/p/1"))?.routeId).toBe(ROUTE_ID["/p/:productId"]);
    expect(page()).toBe("product:1");
  });
});
