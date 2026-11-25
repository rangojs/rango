// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  Activity,
  createElement,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { renderSegments } from "../../segment-system.js";
import type { ResolvedSegment } from "../../types.js";
import { ClientUrlsRoot } from "../client-root.js";
import { clientUrls } from "../client-urls.js";
import { clearClientUrlNavigationRegistry } from "../navigation.js";
import { allowSuspenseAuditViolations } from "../../__tests__/kit/suspense-audit-lock.js";

/**
 * A clientUrls() group's page across a navigation that changes only its
 * params or its search, rendered by renderSegments from the segments a
 * navigation hands it: the group route's segment is keyed by the group
 * (`cg:<group>`, segment-system.tsx) and ClientUrlsRoot keys the page by its
 * route id, so the page and a part of it hidden in <Activity> keep their
 * instance and state. A server route's segment outside a transition() scope
 * keys by its params, the control.
 */

let instances: number;
let log: string[];

function HiddenPart(): ReactNode {
  const [instance] = useState(() => ++instances);
  const [count, setCount] = useState(0);
  useEffect(() => {
    log.push(`effect hidden-part #${instance}`);
    return () => {
      log.push(`cleanup hidden-part #${instance}`);
    };
  }, [instance]);
  return (
    <button data-testid="inner" onClick={() => setCount((n) => n + 1)}>
      {`#${instance} ${count}`}
    </button>
  );
}

function GroupPage(): ReactNode {
  const [instance] = useState(() => ++instances);
  const [count, setCount] = useState(0);
  const [mode, setMode] = useState<"visible" | "hidden">("visible");
  return (
    <>
      <button data-testid="page" onClick={() => setCount((n) => n + 1)}>
        {`#${instance} ${count}`}
      </button>
      <button
        data-testid="toggle"
        onClick={() => setMode((m) => (m === "visible" ? "hidden" : "visible"))}
      />
      <Activity mode={mode}>
        <HiddenPart />
      </Activity>
    </>
  );
}

function Other(): ReactNode {
  return <p>other</p>;
}

const group = clientUrls(({ path }) => [
  path("/g/:group", GroupPage, { name: "group" }),
  path("/other", Other, { name: "other" }),
]);

/** The group route's segment as a navigation to `group` hands it over. */
function groupSegment(groupParam: string): ResolvedSegment {
  return {
    id: "M0R0",
    namespace: "",
    type: "route",
    index: 0,
    component: createElement(ClientUrlsRoot, {
      definition: group,
      routeId: "client-route-0",
    }),
    params: { group: groupParam },
    belongsToRoute: true,
    clientGroup: "/g",
  };
}

/** The same page as a plain server route (no group, no transition()). */
function serverSegment(groupParam: string): ResolvedSegment {
  return {
    id: "M0R0",
    namespace: "",
    type: "route",
    index: 0,
    component: createElement(GroupPage),
    params: { group: groupParam },
    belongsToRoute: true,
  };
}

const text = (id: string): string =>
  document.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";
const click = (id: string): void => {
  fireEvent.click(document.querySelector(`[data-testid="${id}"]`)!);
};

/** Mount at `A`, set page state 2 and hidden-part state 3, hide the part. */
async function openAndHide(
  segment: (groupParam: string) => ResolvedSegment,
): Promise<ReturnType<typeof render>> {
  const result = render(await renderSegments([segment("A")]));
  click("page");
  click("page");
  click("inner");
  click("inner");
  click("inner");
  click("toggle");
  expect(text("page")).toBe("#1 2");
  expect(text("inner")).toBe("#2 3");
  return result;
}

afterEach(() => {
  cleanup();
  clearClientUrlNavigationRegistry();
});

describe("A1: a clientUrls() group page across a param or search change", () => {
  it.each([
    { change: "param", to: "B" },
    { change: "search", to: "A" },
  ])(
    "$change change: the page and its hidden part keep their instance and state",
    async ({ to }) => {
      instances = 0;
      log = [];
      const result = await openAndHide(groupSegment);
      log.push("--- navigate");
      const tree = await renderSegments([groupSegment(to)]);
      act(() => result.rerender(tree));
      expect(text("page")).toBe("#1 2");
      log.push("--- show");
      click("toggle");
      expect(text("inner")).toBe("#2 3");
      expect(instances).toBe(2);
      expect(log).toEqual([
        "effect hidden-part #2",
        "cleanup hidden-part #2",
        "--- navigate",
        "--- show",
        "effect hidden-part #2",
      ]);
    },
  );

  it("control: a server route's param change remounts the page and drops the hidden part", async () => {
    // The remount is this control's point; the dev audit reports it.
    allowSuspenseAuditViolations("the control remounts on purpose");
    instances = 0;
    log = [];
    const result = await openAndHide(serverSegment);
    log.push("--- navigate");
    const tree = await renderSegments([serverSegment("B")]);
    act(() => result.rerender(tree));
    expect(text("page")).toBe("#3 0");
    expect(text("inner")).toBe("#4 0");
    expect(log).toEqual([
      "effect hidden-part #2",
      "cleanup hidden-part #2",
      "--- navigate",
      "effect hidden-part #4",
    ]);
  });
});
