/**
 * THROWAWAY PROBE — which segment a LateHandlePushError names when an async
 * component a handler handed its ctx to pushes after an await.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import { createHandle, createRouter, urls } from "../../index.rsc.js";
import { Outlet } from "../../client.rsc.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

const reported: string[] = [];

async function wait(ms = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function Late({
  ctx,
  label,
}: {
  ctx: any;
  label: string;
}): Promise<React.ReactNode> {
  await wait();
  try {
    ctx.use(Crumbs)(label);
  } catch (error) {
    reported.push(`thrown(${label}): ${(error as Error).message}`);
    throw error;
  }
  return <p>{label}</p>;
}

type Kind = "layout" | "route" | "route-slot" | "slot" | "intercept";

function routerFor(kind: Kind) {
  return createRouter({
    onError: (ctx) => {
      reported.push(
        `onError(${ctx.phase},${ctx.segmentType}): ${ctx.error.name}: ${ctx.error.message}`,
      );
    },
  }).routes(
    urls(({ path, layout, parallel, intercept }) => [
      layout(
        (ctx) => (
          <main>
            {kind === "layout" ? <Late ctx={ctx} label="layout" /> : null}
            <Outlet />
          </main>
        ),
        () => [
          ...(kind === "slot"
            ? [
                parallel({
                  "@side": (ctx) => (
                    <aside>
                      <Late ctx={ctx} label="slot" />
                    </aside>
                  ),
                }),
              ]
            : []),
          path(
            "/x",
            (ctx) => (
              <article>
                {kind === "route" || kind === "route-slot" ? (
                  <Late ctx={ctx} label="route" />
                ) : null}
                x
              </article>
            ),
            { name: "x" },
            () =>
              kind === "route-slot"
                ? [
                    parallel({
                      "@side": () => <aside>side</aside>,
                    }),
                  ]
                : [],
          ),
          ...(kind === "intercept"
            ? [
                intercept(
                  "@modal",
                  ".x",
                  (ctx) => (
                    <dialog>
                      <Late ctx={ctx} label="intercept" />
                    </dialog>
                  ),
                ),
              ]
            : []),
        ],
      ),
    ]),
  );
}

beforeEach(async () => {
  await resetShellTestState();
  reported.length = 0;
});

describe("probe", () => {
  for (const kind of [
    "layout",
    "route",
    "route-slot",
    "slot",
    "intercept",
  ] as const) {
    it(`${kind}`, async () => {
      const router = routerFor(kind);
      const result = await serveShellRequest(router, "/x", {});
      expect(`${kind} => ${reported.join(" | ")}`).toBe("SHOW ME");
    });
  }
});
