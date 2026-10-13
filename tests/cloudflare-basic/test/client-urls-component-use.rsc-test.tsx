// Dogfood: Component.use on the app's clientUrls() group
// (src/client-urls-component-use/urls.tsx), whose layout and page components
// declare their own items in components/page.tsx, imported through a barrel.
// The router mounts the "use client" module with include(), as src/urls.tsx
// does: rangoUseClientTransform (vitest.rsc.config.ts) installs its
// projection, the components' items and predicates included, as the rango
// plugin does in the app. A loader the server re-ran is in the response's
// segments; a held one is not.
import { beforeEach, describe, expect, it } from "vitest";
import { createRouter, urls } from "@rangojs/router";
import {
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestResult,
} from "@rangojs/router/testing/flight";
import type { AppBindings } from "../src/env.js";
import componentUseClientUrls from "../src/client-urls-component-use/urls.js";
import {
  bumpComponentUseStats,
  otherComponentUseAction,
} from "../src/client-urls-component-use/actions.js";
import {
  ComponentUseItemLoader,
  ComponentUseShellLoader,
  ComponentUseStatsLoader,
} from "../src/client-urls-component-use/loader.js";

const env = {} as AppBindings;
const MOUNT = "/client-urls-component-use";
const ACTIONS = "src/client-urls-component-use/actions.ts";

const router = createRouter<AppBindings>({ id: "cu-component-use" }).routes(
  urls(({ include }) => [include(MOUNT, componentUseClientUrls)]),
);

beforeEach(() => resetShellTestState());

interface Segment {
  id: string;
  type: string;
  loading?: unknown;
}

function metadataOf(result: ServeShellRequestResult): {
  matched: string[];
  segments: Segment[];
} {
  const row = result.flight?.split("\n").find((line) => line.startsWith("0:"));
  if (!row) throw new Error("no Flight payload");
  return JSON.parse(row.slice(2)).metadata;
}

/** Which of the components' loaders a response re-ran. */
function rerun(result: ServeShellRequestResult) {
  const loaders = metadataOf(result)
    .segments.filter((segment) => segment.type === "loader")
    .map((segment) => segment.id);
  const has = (loader: { $$id: string }) =>
    loaders.some((id) => id.endsWith(loader.$$id));
  return {
    stats: has(ComponentUseStatsLoader),
    item: has(ComponentUseItemLoader),
    shell: has(ComponentUseShellLoader),
  };
}

async function standingOn(pathname: string): Promise<string[]> {
  return metadataOf(
    await serveShellRequest(router, pathname, {
      env,
      partial: { from: "/" },
    }),
  ).matched;
}

describe("Component.use on a clientUrls() group (cloudflare-basic)", () => {
  it("entering the route runs the layout's and the page's loaders, and the page's loading() is the route's", async () => {
    const result = await serveShellRequest(router, `${MOUNT}/items/alpha`, {
      env,
      partial: { from: "/" },
    });
    expect(rerun(result)).toEqual({ stats: true, item: true, shell: true });
    const loading = metadataOf(result).segments.find(
      (segment) => segment.type === "route",
    )?.loading;
    expect(loading).toBeDefined();
    expect(loading).not.toBe("$undefined");
  });

  it("the page's predicate holds its loader on a param navigation", async () => {
    const segments = await standingOn(`${MOUNT}/items/alpha`);
    const nav = await serveShellRequest(router, `${MOUNT}/items/beta`, {
      env,
      partial: { from: `${MOUNT}/items/alpha`, segments },
    });
    expect(rerun(nav)).toMatchObject({ stats: false, item: true });
  });

  it("an action re-runs it only when it is the action the predicate names", async () => {
    const segments = await standingOn(`${MOUNT}/items/alpha`);
    const call = (ref: () => Promise<void>, name: string) =>
      serveShellRequest(router, `${MOUNT}/items/alpha`, {
        env,
        action: { ref, id: `${ACTIONS}#${name}`, segments },
      });

    const other = await call(
      otherComponentUseAction,
      "otherComponentUseAction",
    );
    expect(other.response.status).toBe(200);
    // The layout's loader follows the default: an action re-runs it.
    expect(rerun(other)).toEqual({ stats: false, item: true, shell: true });

    const bump = await call(bumpComponentUseStats, "bumpComponentUseStats");
    expect(rerun(bump)).toEqual({ stats: true, item: true, shell: true });
  });
});
