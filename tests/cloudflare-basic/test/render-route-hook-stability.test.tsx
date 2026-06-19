// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent } from "@testing-library/react";
import { renderRoute } from "@rangojs/router/testing/dom";
import { useRouter, useHref } from "@rangojs/router/client";

afterEach(cleanup);

// Consumer dogfood: the no-subscription router hooks must return referentially
// stable values across a re-render, exercised through the PUBLIC renderRoute
// primitive + public client hooks (no internal imports). A memoized consumer
// component never re-renders, so an unstable closure would be invisible to a
// render-count check — this asserts identity directly.
describe("useRouter / useHref referential stability (renderRoute dogfood)", () => {
  it("return the same reference across a re-render", async () => {
    const hrefRefs: Array<(p: `/${string}`) => string> = [];
    const routerRefs: unknown[] = [];

    function Probe() {
      const router = useRouter();
      const href = useHref();
      const [, setN] = useState(0);
      routerRefs.push(router);
      hrefRefs.push(href);
      return (
        <button data-testid="rerender" onClick={() => setN((n) => n + 1)}>
          {href("/")}
        </button>
      );
    }

    const { getByTestId } = await renderRoute(
      [{ path: "/p/:id", Component: Probe }],
      { request: "/p/1" },
    );

    const firstHref = hrefRefs.at(-1);
    const firstRouter = routerRefs.at(-1);

    // Force a same-fiber re-render via local state (NOT a navigation, which
    // would remount and reset the memo).
    fireEvent.click(getByTestId("rerender"));

    expect(hrefRefs.length, "probe actually re-rendered").toBeGreaterThan(1);
    expect(hrefRefs.at(-1), "useHref reference stable").toBe(firstHref);
    expect(routerRefs.at(-1), "useRouter reference stable").toBe(firstRouter);
  });
});
