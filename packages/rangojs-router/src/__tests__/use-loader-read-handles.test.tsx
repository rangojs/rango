// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createEventController } from "../browser/event-controller.js";
import { createNavigationStore } from "../browser/navigation-store.js";
import {
  NavigationStoreContext,
  type NavigationStoreContextValue,
} from "../browser/react/context.js";
import { OutletProvider } from "../outlet-provider.js";
import { pushedByKey } from "../handles/pushed-by.js";
import { loaderAnswerResponse } from "../testing/vitest-stubs/plugin-rsc-browser.js";
import { useFetchLoader, type LoadFunction } from "../use-loader.js";
import type { LoaderDefinition, LoadOptions } from "../types.js";

const ProductLoader = { $$id: "product" } as unknown as LoaderDefinition<{
  name: string;
}>;

/**
 * Route R0 registers the product loader, whose render pushed the title
 * "Product 1". Each read is answered by `answer(name)`, in the order sent,
 * with that name as its data and its title push (rsc/loader-fetch.ts's reply,
 * as the Flight stub decodes it).
 */
function mountPage(key?: string) {
  const eventController = createEventController({
    initialLocation: new URL("http://localhost/product/1"),
  });
  const store = createNavigationStore({
    initialLocation: new URL("http://localhost/product/1"),
  });
  const rendered = {
    Meta: { R0: [{ title: "Product 1" }] },
    [pushedByKey("Meta")]: { R0: ["product"] },
  };
  store.setHistoryKey("/product/1");
  store.cacheSegmentsForHistory("/product/1", [], rendered);
  eventController.setHandleData(rendered, ["R0D0.product", "R0"]);
  const replies: ((name: string) => void)[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise<Response>((resolve) =>
        replies.push((name) => resolve(loaderAnswerResponse(replyOf(name)))),
      ),
  );

  let load!: LoadFunction<{ name: string }>;
  function Reader() {
    load = useFetchLoader(ProductLoader, { key }).load;
    return null;
  }
  render(
    <NavigationStoreContext.Provider
      value={{ store, eventController } as NavigationStoreContextValue}
    >
      <OutletProvider
        content={null}
        loaderData={{ product: { name: "Product 1" } }}
      >
        <Reader />
      </OutletProvider>
    </NavigationStoreContext.Provider>,
  );
  const title = () => eventController.getHandleState().data.Meta.R0;
  const read = (options?: LoadOptions) => load(options);
  const answer = (name: string) => act(async () => replies.shift()!(name));
  return { read, answer, title };
}

function replyOf(name: string) {
  return { loaderResult: { name }, handles: { Meta: [{ title: name }] } };
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve)));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a load() read's handle values", () => {
  it("apply for a refetch of the page's own read", async () => {
    const page = mountPage();
    const read = page.read();
    await page.answer("Product 1, renamed");
    await read;
    await settle();
    expect(page.title()).toEqual([{ title: "Product 1, renamed" }]);
  });

  it.each<[string, LoadOptions, string?]>([
    ["other params (a hover preview)", { params: { id: "2" } }],
    ["other params in a keyed bucket", { params: { id: "2" } }, "preview"],
    ["a POST body", { method: "POST", body: { id: "2" } }],
  ])(
    "are dropped for a read of data the page does not show: %s",
    async (_, options, key) => {
      const page = mountPage(key);
      const read = page.read(options);
      await page.answer("Product 2");
      await expect(read).resolves.toEqual({ name: "Product 2" });
      await settle();
      expect(page.title()).toEqual([{ title: "Product 1" }]);
    },
  );

  it("are applied for the page's read when a preview was sent after it", async () => {
    const page = mountPage();
    const refetch = page.read();
    const preview = page.read({ params: { id: "2" } });
    await page.answer("Product 1, renamed");
    await page.answer("Product 2");
    await Promise.all([refetch, preview]);
    await settle();
    expect(page.title()).toEqual([{ title: "Product 1, renamed" }]);
  });
});
