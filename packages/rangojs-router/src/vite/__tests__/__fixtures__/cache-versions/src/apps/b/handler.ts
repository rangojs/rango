import { router } from "./router.js";

// Code this app runs that the module calling createRouter() never imports:
// only this module reaches wiring.ts, and through a dynamic import, so it
// lands in a chunk of its own.
export default async (request: Request, input: any) => {
  const { tagResponse } = await import("./wiring.js");
  return tagResponse(await router.fetch(request, input));
};
