import { createLoader } from "@rangojs/router";

export interface ArticleStatsData {
  renderedAt: string;
}

export const ArticleStatsLoader = createLoader(
  async (): Promise<ArticleStatsData> => {
    return { renderedAt: new Date().toISOString() };
  },
);
