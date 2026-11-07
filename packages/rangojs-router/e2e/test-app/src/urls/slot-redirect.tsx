import type { ReactNode } from "react";
import { cookies, redirect, urls } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import {
  SlotRedirectArm,
  SlotRedirectRefresh,
} from "./slot-redirect.client.js";

// An intercept and two route-level parallel slots whose handlers return
// redirect() to /slot-redirect/done once the `sr-armed` cookie is set (the
// Arm button's server action sets it):
//  - /item, opened over the index, is intercepted by an async @modal
//    handler under loading();
//  - /streamed has an async @side slot under loading();
//  - /plain has a sync @side slot with no loading().
// Each redirects as a route handler there would: an action's revalidation
// awaits every handler, and the rest redirect unless the handler streams.
// Mounted at /slot-redirect. Body:
// tests/shared-e2e/src/slot-redirect-scenario.ts.

const DONE = "/slot-redirect/done";

function armed(): boolean {
  return cookies().get("sr-armed")?.value === "1";
}

async function streamedRedirect(body: ReactNode) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return armed() ? redirect(DONE) : body;
}

function SlotRedirectLayout() {
  return (
    <div data-testid="sr-layout">
      <Outlet />
      <Outlet name="@modal" />
    </div>
  );
}

function SlotRedirectPage({ testId }: { testId: string }) {
  return (
    <div data-testid={testId}>
      <Outlet name="@side" />
    </div>
  );
}

export const slotRedirectPatterns = urls(
  ({ layout, path, intercept, parallel, loading }) => [
    layout(SlotRedirectLayout, () => [
      path(
        "/",
        () => (
          <div data-testid="sr-index">
            <Link
              to="/slot-redirect/item"
              prefetch="none"
              data-testid="sr-to-item"
            >
              Item
            </Link>
            <Link
              to="/slot-redirect/plain"
              prefetch="none"
              data-testid="sr-to-plain"
            >
              Plain slot
            </Link>
          </div>
        ),
        { name: "index" },
      ),
      path("/item", () => <div data-testid="sr-item-page">item page</div>, {
        name: "item",
      }),
      intercept(
        "@modal",
        ".item",
        () =>
          streamedRedirect(
            <div data-testid="sr-modal">
              <SlotRedirectArm />
            </div>,
          ),
        () => [loading(<p data-testid="sr-modal-loading">loading</p>)],
      ),
      path(
        "/streamed",
        () => <SlotRedirectPage testId="sr-streamed" />,
        { name: "streamed" },
        () => [
          parallel(
            {
              "@side": () =>
                streamedRedirect(
                  <aside data-testid="sr-streamed-side">
                    <SlotRedirectArm />
                  </aside>,
                ),
            },
            () => [loading(<p data-testid="sr-side-loading">loading</p>)],
          ),
        ],
      ),
      path(
        "/plain",
        () => <SlotRedirectPage testId="sr-plain" />,
        { name: "plain" },
        () => [
          parallel({
            "@side": () =>
              armed() ? (
                redirect(DONE)
              ) : (
                <aside data-testid="sr-plain-side">
                  <SlotRedirectRefresh />
                </aside>
              ),
          }),
        ],
      ),
      path("/done", () => <div data-testid="sr-done">done</div>, {
        name: "done",
      }),
    ]),
  ],
);
