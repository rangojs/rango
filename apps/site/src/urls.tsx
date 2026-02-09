import { urls } from "@rangojs/router";
import { HomePage } from "./pages/home.js";

export const urlpatterns = urls(({ path }) => [
  path("/", HomePage, { name: "home" }),
]);
