import {
  Breadcrumbs,
  createLoader,
  getRequestContext,
  Meta,
} from "@rangojs/router";
import type { AppBindings } from "../env.js";
import { readLoaderReadHandlesTally } from "./loader-read-handles.store.js";

// Registered fetchable loader of /loader-read-handles/chat
// (loader-read-handles.tsx): names the chat by its run, and writes the page's
// title and its crumb from the name, as a chat page whose rename reaches it
// through a refresh does.
let loaderReadHandlesRun = 0;

export const LoaderReadHandlesChat = createLoader(
  async (ctx): Promise<{ name: string }> => {
    loaderReadHandlesRun++;
    const name = `Chat ${loaderReadHandlesRun}`;
    ctx.use(Meta)({ title: `LRH ${name}` });
    ctx.use(Breadcrumbs)({ label: name, href: "/loader-read-handles/chat" });
    return { name };
  },
  true,
);

// Registered on /loader-read-handles/kept beside the chat loader, which that
// page keeps across an action: this one re-runs after it, and holds its data
// back when the action asked for that (loader-read-handles.store.ts).
export const LoaderReadHandlesTally = createLoader(
  async (): Promise<{ tally: number }> => ({
    tally: await readLoaderReadHandlesTally(),
  }),
);

// The release flag lives in KV, so the request that holds the late crumb and
// the one that releases it need not share an isolate or a promise.
const LATE_RELEASED = "loader-read-handles:late-released:";

// Registered on /loader-read-handles/late beside the chat loader: pushes its
// crumb once a request to the page with ?lateRelease=<probe> released its
// ?lateHold=<probe> (at most 30 s), so the push misses the handler barrier
// and reaches the browser on the document's late handle channel, carrying
// the document's state of the chat loader with it.
export const LoaderReadHandlesLate = createLoader(
  async (ctx): Promise<{ late: true }> => {
    const kv = getRequestContext<AppBindings>().env.KV;
    const release = ctx.searchParams.get("lateRelease");
    if (release !== null) {
      await kv.put(`${LATE_RELEASED}${release}`, "1");
      return { late: true };
    }
    const key = `${LATE_RELEASED}${ctx.searchParams.get("lateHold") ?? ""}`;
    const until = Date.now() + 30000;
    while ((await kv.get(key)) !== "1" && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await kv.delete(key);
    ctx.use(Breadcrumbs)({ label: "Late", href: "/loader-read-handles/late" });
    return { late: true };
  },
);
