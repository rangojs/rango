import { Breadcrumbs, createLoader, Meta } from "@rangojs/router";

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

// Registered on /loader-read-handles/late beside the chat loader: pushes its
// crumb after an await (?lateDelay ms, default 3000), so the push misses the
// handler barrier and reaches the browser on the document's late handle
// channel, carrying the document's state of the chat loader with it.
export const LoaderReadHandlesLate = createLoader(
  async (ctx): Promise<{ late: true }> => {
    const delay = Number(ctx.searchParams.get("lateDelay") ?? 3000);
    await new Promise((resolve) => setTimeout(resolve, delay));
    ctx.use(Breadcrumbs)({ label: "Late", href: "/loader-read-handles/late" });
    return { late: true };
  },
);
