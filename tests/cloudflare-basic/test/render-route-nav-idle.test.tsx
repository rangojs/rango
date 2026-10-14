// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderRoute } from "@rangojs/router/testing/dom";
import { NavIdleFilters } from "../src/components/NavIdleFilters.js";
import { installViewTransitionStub } from "@shared/e2e/view-transition-stub";

// Consumer dogfood (#1164) through the PUBLIC renderRoute: the app's filter
// chips (the e2e probe of /nav-idle and /nav-idle-vt) never commit
// useNavigation() idle with useSearchParams() still on the old search, so a
// removed chip never comes back. renderRoute commits a navigate() in a
// transition only for a transition() route; without one it commits urgently.

type LogEntry = {
  idle: boolean;
  fullIdle: boolean;
  search: string;
  shown: string;
};
const probe = (): { __navIdleLog?: LogEntry[] } =>
  window as unknown as { __navIdleLog?: LogEntry[] };

let stub: ReturnType<typeof installViewTransitionStub> | undefined;

beforeEach(() => {
  stub = undefined;
  probe().__navIdleLog = [];
});

afterEach(() => {
  cleanup();
  stub?.uninstall();
});

describe.each([
  { variant: "transition(), view transitions supported", tx: true, vt: true },
  {
    variant: "transition(), view transitions unsupported",
    tx: true,
    vt: false,
  },
  { variant: "no transition(), urgent commit", tx: false, vt: false },
])("NavIdleFilters through renderRoute ($variant)", ({ tx, vt }) => {
  it("removing a chip never commits idle with the old search", async () => {
    if (vt) stub = installViewTransitionStub();
    const { getByTestId, queryByTestId } = await renderRoute(
      [
        {
          path: "/nav-idle",
          Component: NavIdleFilters,
          ...(tx && { transition: {} }),
        },
      ],
      { request: "/nav-idle?tag=a&tag=b" },
    );
    probe().__navIdleLog = [];

    fireEvent.click(getByTestId("nav-idle-remove-a"));
    await waitFor(() =>
      expect(probe().__navIdleLog?.at(-1)).toEqual({
        idle: true,
        fullIdle: true,
        search: "tag=b",
        shown: "b",
      }),
    );

    const log = probe().__navIdleLog ?? [];
    expect(log.map((entry) => entry.shown)).toEqual(log.map(() => "b"));
    for (const read of ["idle", "fullIdle"] as const) {
      const fromLoading = log
        .slice(log.findIndex((entry) => !entry[read]))
        .map((entry) => `${entry[read] ? "idle" : "loading"} ${entry.search}`)
        .filter((entry, i, all) => all[i - 1] !== entry);
      expect(fromLoading, read).toEqual(["loading tag=a&tag=b", "idle tag=b"]);
    }
    expect(queryByTestId("nav-idle-remove-a")).toBeNull();
    expect((stub?.started() ?? 0) > 0).toBe(vt);
  });
});
