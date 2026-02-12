import { defineEventHandler, toWebRequest } from "h3";

// @ts-expect-error -- built output has no declaration file
import handler from "../../dist/rsc/index.js";

export default defineEventHandler(async (event) => {
  const webRequest = toWebRequest(event);
  return handler(webRequest);
});
