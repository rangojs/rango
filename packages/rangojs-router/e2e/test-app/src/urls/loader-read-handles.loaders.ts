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
