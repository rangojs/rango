import { urls } from "@rangojs/router";
import {
  SkipArticle,
  SkipStaticHandler,
  SkipWorkingStatic,
} from "./build-skip-handler.js";

export const buildSkipPatterns = urls(({ path }) => [
  path("/:slug", SkipArticle, { name: "article" }),
  path("/static-skip", SkipStaticHandler, { name: "staticSkip" }),
  path("/working-static", SkipWorkingStatic, { name: "workingStatic" }),
]);
