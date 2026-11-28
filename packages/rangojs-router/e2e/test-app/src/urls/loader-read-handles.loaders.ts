import { Breadcrumbs, createLoader, Meta } from "@rangojs/router";
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

// The ?lateHold probes a request with ?lateRelease has released.
const releasedLate = new Set<string>();

// Registered on /loader-read-handles/late beside the chat loader: pushes its
// crumb once a request to the page with ?lateRelease=<probe> released its
// ?lateHold=<probe> (at most 30 s), so the push misses the handler barrier
// and reaches the browser on the document's late handle channel, carrying
// the document's state of the chat loader with it.
export const LoaderReadHandlesLate = createLoader(
  async (ctx): Promise<{ late: true }> => {
    const release = ctx.searchParams.get("lateRelease");
    if (release !== null) {
      releasedLate.add(release);
      return { late: true };
    }
    const probe = ctx.searchParams.get("lateHold") ?? "";
    const until = Date.now() + 30000;
    while (!releasedLate.has(probe) && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    releasedLate.delete(probe);
    ctx.use(Breadcrumbs)({ label: "Late", href: "/loader-read-handles/late" });
    return { late: true };
  },
);
