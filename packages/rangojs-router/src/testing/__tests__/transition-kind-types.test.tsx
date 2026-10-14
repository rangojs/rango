// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ViewTransition } from "react";
import { act, cleanup } from "@testing-library/react";
import { useParams } from "../../browser/react/use-params.js";
import { renderRoute } from "../dom.entry.js";

/**
 * #1165 through renderRoute: a navigate() commit under transition() carries
 * its transition({ when }) kind, so an app <ViewTransition> class map keyed
 * by kind tells a push from a replace from a refresh. happy-dom has no view
 * transitions: the three stubs below let React run its view-transition
 * commit, which is where it resolves class maps and calls a
 * <ViewTransition>'s event callbacks with the commit's types.
 */

function stubViewTransitions(): void {
  const settled = Promise.resolve();
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { status: "loaded", ready: settled },
  });
  Object.assign(document.documentElement, { getAnimations: () => [] });
  Object.assign(document, {
    startViewTransition(options: { update: () => void }) {
      const done = settled.then(() => options.update());
      return {
        ready: done,
        finished: done,
        updateCallbackDone: done,
        skipTransition() {},
      };
    },
  });
}

let commits = 0;
const every: string[][] = [];
const pageMap: string[][] = [];

function Item() {
  const { id } = useParams<{ id: string }>();
  commits++;
  return (
    <>
      {/* Activates on every transition commit: records each one's types. */}
      <ViewTransition onUpdate={(_, types) => void every.push([...types])}>
        <p>{`${id}:${commits}`}</p>
      </ViewTransition>
      {/* Activates only where its map resolves a class other than none. */}
      <ViewTransition
        update={{ push: "page", replace: "page", default: "none" }}
        onUpdate={(_, types) => void pageMap.push([...types])}
      >
        <p data-testid="id">{`${id}:${commits}`}</p>
      </ViewTransition>
    </>
  );
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

beforeEach(() => {
  stubViewTransitions();
  commits = 0;
  every.length = 0;
  pageMap.length = 0;
});
afterEach(() => cleanup());

describe("renderRoute: every transition commit carries its kind (#1165)", () => {
  it("push, replace and refresh() reach a <ViewTransition>, and a push/replace map skips the refresh", async () => {
    const { router, getByTestId } = await renderRoute(
      [
        {
          path: "/items/:id",
          Component: Item,
          transition: { viewTransition: false },
        },
      ],
      { request: "/items/1" },
    );

    await router.navigate("/items/2");
    await settle();
    await router.navigate("/items/3", { replace: true });
    await settle();
    await router.refresh();
    await settle();

    expect(getByTestId("id").textContent).toMatch(/^3:/);
    expect(every).toEqual([
      ["push", "navigation"],
      ["replace", "navigation"],
      ["revalidate", "navigation"],
    ]);
    expect(pageMap).toEqual([
      ["push", "navigation"],
      ["replace", "navigation"],
    ]);
  });
});
