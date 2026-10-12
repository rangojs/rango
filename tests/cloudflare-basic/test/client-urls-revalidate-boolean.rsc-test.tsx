// Dogfood: revalidate(true) / revalidate(false) on the app's clientUrls()
// group (src/client-urls/urls.tsx) through serveShellRequest. The router
// mounts the "use client" module with include(), as src/urls.tsx does: here
// it is a client reference, and rangoUseClientTransform
// (vitest.rsc.config.ts) installs its projection, as the rango plugin's
// discovery does in the app. A loader the server re-runs is in the
// response's segments; a held one is not.
import { beforeEach, describe, expect, it } from "vitest";
import { createRouter, urls } from "@rangojs/router";
import {
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestResult,
} from "@rangojs/router/testing/flight";
import type { AppBindings } from "../src/env.js";
import pureClientUrls from "../src/client-urls/urls.js";
import { clientUrlsTargetAction } from "../src/client-urls/actions.js";
import {
  ClientUrlsAlwaysLoader,
  ClientUrlsHeldLoader,
  ClientUrlsResultLoader,
} from "../src/client-urls/loader.js";

const env = {} as AppBindings;
const INDEX = "/__client-urls";

const router = createRouter<AppBindings>({
  id: "cu-revalidate-boolean",
}).routes(urls(({ include }) => [include(INDEX, pureClientUrls)]));

beforeEach(() => resetShellTestState());

/** The payload's `metadata.matched` and the loaders it re-sent. */
function metadataOf(result: ServeShellRequestResult): {
  matched: string[];
  loaders: string[];
} {
  const row = result.flight?.split("\n").find((line) => line.startsWith("0:"));
  if (!row) throw new Error("no Flight payload");
  const { matched, segments } = JSON.parse(row.slice(2)).metadata as {
    matched: string[];
    segments: { id: string; type: string }[];
  };
  return {
    matched,
    loaders: segments.filter((s) => s.type === "loader").map((s) => s.id),
  };
}

/** Which of the probed loaders a response re-ran. */
function rerun(result: ServeShellRequestResult) {
  const { loaders } = metadataOf(result);
  const has = (loader: { $$id: string }) =>
    loaders.some((id) => id.endsWith(loader.$$id));
  return {
    always: has(ClientUrlsAlwaysLoader),
    held: has(ClientUrlsHeldLoader),
    plain: has(ClientUrlsResultLoader),
  };
}

async function standingOnIndex(): Promise<string[]> {
  return metadataOf(
    await serveShellRequest(router, INDEX, { env, partial: { from: "/" } }),
  ).matched;
}

describe("revalidate(true) / revalidate(false) on a clientUrls() group loader (cloudflare-basic)", () => {
  it("a same-URL navigation re-runs revalidate(true) where the default holds; revalidate(false) holds", async () => {
    const segments = await standingOnIndex();
    const nav = await serveShellRequest(router, INDEX, {
      env,
      partial: { from: INDEX, segments },
    });
    // ClientUrlsResultLoader's onResultOk defers on a navigation: the default.
    expect(rerun(nav)).toEqual({ always: true, held: false, plain: false });
  });

  it("an action re-runs revalidate(true) and the default; revalidate(false) holds", async () => {
    const segments = await standingOnIndex();
    const action = await serveShellRequest(router, INDEX, {
      env,
      action: {
        ref: clientUrlsTargetAction,
        id: "src/client-urls/actions.ts#clientUrlsTargetAction",
        segments,
      },
    });
    expect(action.response.status).toBe(200);
    expect(rerun(action)).toEqual({ always: true, held: false, plain: true });
  });
});
