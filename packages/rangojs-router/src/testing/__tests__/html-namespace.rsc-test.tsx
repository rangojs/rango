// Html from @rangojs/router/client used by a SERVER root layout. Under the
// react-server condition that specifier resolves to client.rsc.tsx, imported
// here directly. Each Html member must cross Flight as its own client boundary;
// if Html itself came from a "use client" module it would be one opaque client
// reference with no `.Head`, and the render would fail.
import type { ReactNode } from "react";
import { describe, expect, test } from "vitest";
import {
  findClientBoundaries,
  findElements,
  renderServerTree,
} from "../flight.entry.js";
import * as clientRsc from "../../client.rsc.js";

const { Html } = clientRsc;

async function RootLayout({ children }: { children: ReactNode }) {
  await Promise.resolve();
  return (
    <html lang="en">
      <head>
        <Html.Meta />
        <Html.Scripts />
      </head>
      <body>
        <Html.Scripts position="body" />
        <Html.ScrollRestoration />
        {children}
      </body>
    </html>
  );
}

describe("Html in a server component (react-server)", () => {
  test("each member serializes as its own client boundary", async () => {
    const { tree } = await renderServerTree(
      <RootLayout>
        <main>page</main>
      </RootLayout>,
    );

    // Boundary names are the members' module export names.
    expect(findClientBoundaries(tree).map((b) => b.name)).toEqual([
      "MetaTags",
      "Scripts",
      "Scripts",
      "ScrollRestoration",
    ]);
    expect(
      findClientBoundaries(tree, {
        name: "Scripts",
        props: { position: "body" },
      }),
    ).toHaveLength(1);
    expect(findElements(tree, "main")[0]?.text).toBe("page");
  });
});
