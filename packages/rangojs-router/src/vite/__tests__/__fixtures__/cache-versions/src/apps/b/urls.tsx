import { urls } from "@rangojs/router";
// A dependency the node preset leaves external: the built chunk says
// `from "ext-lib"` whatever version is installed.
import { extLabel } from "ext-lib";
import { greeting } from "../../shared/greeting.js";
import { Badge } from "./Badge.js";
import { ping } from "./actions.js";
import pages from "./pages.js";

export const urlpatterns = urls(({ path, include }) => [
  path(
    "/",
    () => (
      <main>
        <h1>{greeting("app B")}</h1>
        <p>{extLabel()}</p>
        <Badge />
        <form action={ping}>
          <button type="submit">Ping</button>
        </form>
      </main>
    ),
    { name: "home" },
  ),
  include("/pages", pages, { name: "pages" }),
]);
