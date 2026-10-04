import { urls } from "@rangojs/router";
import { greeting } from "../../shared/greeting.js";
import { Counter } from "./Counter.js";
import { LikeForm } from "./LikeForm.js";
import { Note } from "./note.js";

export const urlpatterns = urls(({ path }) => [
  path(
    "/",
    () => (
      <main>
        <h1>{greeting("app A")}</h1>
        <Counter />
        <LikeForm />
      </main>
    ),
    { name: "home" },
  ),
  path("/note/:id", (ctx) => <Note id={ctx.params.id} />, { name: "note" }),
]);
