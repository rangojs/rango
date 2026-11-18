import { createLoader, Meta } from "@rangojs/router";

// A fetchable loader no route registers (push-handle.tsx): the project page
// reads it with useFetchLoader() and load() and pushes the title and crumb
// from its data with usePushHandle, since a read of an unregistered loader has
// no segment for pushes of its own. Names the project by its run.
let pushHandleProjectRun = 0;

export const PushHandleProjectLoader = createLoader(
  async (): Promise<{ name: string }> => {
    pushHandleProjectRun++;
    return { name: `Project ${pushHandleProjectRun}` };
  },
  true,
);

// The clientUrls group's loader (push-handle.client-urls.tsx): pushes the
// page's title from its data on the server, on a render and on a read.
let pushHandleGroupRun = 0;

export const PushHandleGroupLoader = createLoader(
  async (ctx): Promise<{ name: string }> => {
    pushHandleGroupRun++;
    const name = `Group ${pushHandleGroupRun}`;
    ctx.use(Meta)({ title: `PHG ${name}` });
    return { name };
  },
  true,
);
