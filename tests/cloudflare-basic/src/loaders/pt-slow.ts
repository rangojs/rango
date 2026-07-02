import { createLoader } from "@rangojs/router";

const SLOW_LOADER_DELAY = 800;

export interface PtSlowData {
  message: string;
}

// #622 follow-up: a slow loader so /pt-slow has a loading() boundary worth
// observing on a fully-prefetched (no-flash) vs cold (streamed) navigation.
export const PtSlowLoader = createLoader(async (): Promise<PtSlowData> => {
  await new Promise((resolve) => setTimeout(resolve, SLOW_LOADER_DELAY));
  return { message: "pt-slow loaded" };
});
