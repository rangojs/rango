import { createLoader } from "@rangojs/router";

export const MixedClientDetailLoader = createLoader(
  async (ctx): Promise<{ slug: string; source: string }> => {
    await new Promise((resolve) => setTimeout(resolve, 500));

    return {
      slug: ctx.params.slug ?? "missing-slug",
      source: "Cloudflare server loader",
    };
  },
);
