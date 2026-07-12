import { urls } from "@rangojs/router";
import { GuidesDetail, PersonalizedGuide } from "./guides-handler.js";

export const guidesPatterns = urls(({ path }) => [
  path("/personalized/:slug", PersonalizedGuide, { name: "personalized" }),
  path("/:slug", GuidesDetail, { name: "detail" }),
]);
