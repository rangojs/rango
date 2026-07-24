import { createLoader } from "@rangojs/router";

export const ClientUrlsDetailLoader = createLoader(
  async (ctx): Promise<{ slug: string }> => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    return { slug: ctx.params.slug ?? "missing-slug" };
  },
);
