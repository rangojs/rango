import { describe, it, expect } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { MountContext } from "../browser/react/mount-context.js";
import { useMount } from "../browser/react/use-mount.js";

function MountDisplay() {
  const mount = useMount();
  return <span data-mount={mount}>{mount}</span>;
}

describe("useMount()", () => {
  it('returns "/" when no provider', () => {
    const html = renderToString(<MountDisplay />);
    expect(html).toContain("/");
    expect(html).toContain('data-mount="/"');
  });

  it("returns correct mount path from provider", () => {
    const html = renderToString(
      <MountContext.Provider value="/articles">
        <MountDisplay />
      </MountContext.Provider>,
    );
    expect(html).toContain("/articles");
    expect(html).toContain('data-mount="/articles"');
  });

  it("nested providers: inner overrides outer", () => {
    const html = renderToString(
      <MountContext.Provider value="/articles">
        <MountContext.Provider value="/articles/comments">
          <MountDisplay />
        </MountContext.Provider>
      </MountContext.Provider>,
    );
    expect(html).toContain("/articles/comments");
    expect(html).toContain('data-mount="/articles/comments"');
  });

  it("sibling providers are independent", () => {
    function App() {
      return (
        <div>
          <MountContext.Provider value="/blog">
            <MountDisplay />
          </MountContext.Provider>
          <MountContext.Provider value="/shop">
            <MountDisplay />
          </MountContext.Provider>
        </div>
      );
    }

    const html = renderToString(<App />);
    expect(html).toContain('data-mount="/blog"');
    expect(html).toContain('data-mount="/shop"');
  });
});
