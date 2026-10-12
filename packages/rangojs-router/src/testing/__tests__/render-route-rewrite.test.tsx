// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { useParams, usePathname, useSearchParams } from "../../client.js";
import { renderRoute } from "../dom.entry.js";

// A page middleware rewrote to (`throw rewrite()`) renders the target's route
// at the visitor's URL: the server markup and hydration both read the address
// bar, so a target component rendering usePathname() hydrates clean.

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "");
});

function MaintenanceBanner() {
  const pathname = usePathname();
  const [search] = useSearchParams();
  const { slug } = useParams<{ slug: string }>();
  return (
    <p data-testid="banner">{`${pathname}?${search.toString()} ${slug}`}</p>
  );
}

describe("renderRoute: rewrite", () => {
  it("renders the target's route at the visitor's URL and hydrates clean", async () => {
    const { serverHtml, recoverableErrors, getByTestId, router } =
      await renderRoute(
        [{ path: "/maintenance/:slug", Component: MaintenanceBanner }],
        {
          request: "/shop?q=hats",
          rewrite: "/maintenance/winter",
          hydrate: true,
        },
      );

    expect(serverHtml).toContain("/shop?q=hats winter");
    expect(recoverableErrors).toEqual([]);
    expect(getByTestId("banner").textContent).toBe("/shop?q=hats winter");
    expect(router.pathname()).toBe("/shop");
  });

  it("matches the leaf against the rewrite target, not the request", async () => {
    await expect(
      renderRoute(
        [{ path: "/maintenance/:slug", Component: MaintenanceBanner }],
        {
          request: "/shop",
          rewrite: "/elsewhere",
        },
      ),
    ).rejects.toThrow('request "/elsewhere" does not match the leaf route');
  });
});
