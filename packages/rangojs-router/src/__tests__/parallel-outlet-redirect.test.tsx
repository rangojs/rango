// @vitest-environment happy-dom
import { useEffect, type ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ParallelOutlet } from "../client.js";
import { OutletContext } from "../outlet-context.js";
import type { ResolvedSegment } from "../types.js";
import { renderRedirectDigest } from "../errors.js";

// A slot component's `throw redirect()` that React meets while it renders
// (an async component nested in a parallel or intercept slot's element) is
// followed by the slot's own router boundary (client.tsx renderSlotContent):
// the slot alone is replaced, and the layout that renders it stays mounted.

// LoaderRedirect navigates through the router context; here it only names
// its target.
vi.mock("../loader-redirect.js", () => ({
  LoaderRedirect: ({ to }: { to: string }) => <i>redirecting to {to}</i>,
}));

afterEach(cleanup);
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function Redirecting(): null {
  throw Object.assign(new Error("decoded"), {
    digest: renderRedirectDigest({ to: "/target" }),
  });
}

function slot(component: ReactNode): ResolvedSegment {
  return {
    id: "L0.@modal",
    namespace: "modal",
    type: "parallel",
    slot: "@modal",
    index: 0,
    component,
  } as ResolvedSegment;
}

describe("a slot component's redirect met while React renders", () => {
  it("replaces the slot alone; the layout around it keeps its instance", async () => {
    let layoutMounts = 0;
    function Layout(): ReactNode {
      useEffect(() => {
        layoutMounts++;
      }, []);
      return (
        <div data-testid="layout">
          <ParallelOutlet name="@modal" />
        </div>
      );
    }
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <OutletContext.Provider
          value={{ content: null, parallel: [slot(<Redirecting />)] }}
        >
          <Layout />
        </OutletContext.Provider>,
      );
    });

    expect(view.getByTestId("layout").textContent).toBe(
      "redirecting to /target",
    );
    expect(layoutMounts).toBe(1);
  });
});
