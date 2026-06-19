// @vitest-environment happy-dom
/**
 * DefaultDocument is what apps get when they pass no custom Document to
 * createRouter. This pins that it wires the Script handle out of the box: a
 * `<Scripts/>` site in <head> and a `<Scripts position="body"/>` site in <body>,
 * with the request nonce applied. Rendered through renderRoute (which seeds the
 * Script handle + NonceContext the same way the real app does); React 19 hoists
 * the head content to the real document.head, while the body site renders in the
 * render container.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { renderRoute } from "../../testing/render-route.js";
import { DefaultDocument } from "../DefaultDocument.js";
import { Script } from "../../handles/script.js";

afterEach(cleanup);

describe("DefaultDocument", () => {
  it("renders Script handle scripts in head and body out of the box, with the nonce", async () => {
    const Probe = () => (
      <DefaultDocument>
        <div data-testid="child">hi</div>
      </DefaultDocument>
    );

    const { container } = await renderRoute([{ path: "/", Component: Probe }], {
      request: "/",
      nonce: "doc-nonce",
      handles: [
        [
          Script,
          [
            { id: "doc-head", children: "window.__docHead = 1;" },
            {
              id: "doc-body",
              children: "window.__docBody = 1;",
              position: "body",
            },
          ],
        ],
      ],
    });

    // Head <Scripts/>: hoisted by React into the real document head, nonced.
    const headScript = document.head.querySelector("#doc-head");
    expect(headScript?.textContent).toContain("__docHead");
    expect(headScript?.getAttribute("nonce")).toBe("doc-nonce");

    // Body <Scripts position="body"/>: rendered in place, nonced.
    const bodyScript = container.querySelector("#doc-body");
    expect(bodyScript?.textContent).toContain("__docBody");
    expect(bodyScript?.getAttribute("nonce")).toBe("doc-nonce");
  });
});
