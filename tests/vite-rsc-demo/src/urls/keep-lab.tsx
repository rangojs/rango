import { urls, Meta } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { KeepLabLayout, KeepLabPage } from "./keep-lab.client.js";
import {
  KeepLabALoader,
  KeepLabBLoader,
  KeepLabCLoader,
} from "./keep-lab.loaders.js";
import { KEEP_LAB_MODES } from "./keep-lab.modes.js";

// SPIKE (keep lab): kept pages side by side. Modes 1 to 4 are server routes
// here; mode 5 is the clientUrls() group in keep-lab-group.client.tsx.

function KeepLabIndex() {
  return (
    <main>
      <h1>Keep lab</h1>
      <p>
        The same three pages, each with a 400 ms loader whose read number and
        time change on every read, a pushed title and crumb, a text input, an
        expandable panel and a scrolled list. Try the same clicks in each mode:
        open page A, go to B, come back to A with the plain link, come back with
        the search link, then press Back.
      </p>
      <ul>
        {KEEP_LAB_MODES.map((info) => (
          <li key={info.mode} style={{ marginBottom: "0.75rem" }}>
            <Link to={`/keep-lab/${info.mode}/a`} data-kl-mode={info.mode}>
              {info.label}
            </Link>
            <br />
            {info.setup}
            <br />
            <em>Watch for:</em> {info.watch}
          </li>
        ))}
      </ul>
    </main>
  );
}

// Route names and paths stay literal: the route-type generator reads them
// from source.
export const keepLabPatterns = urls(({ path, layout, loader, transition }) => [
  path(
    "/",
    (ctx) => {
      ctx.use(Meta)({ title: "Keep lab" });
      return <KeepLabIndex />;
    },
    { name: "index" },
  ),
  layout(
    () => <KeepLabLayout mode="plain" />,
    () => [
      path(
        "/plain/a",
        () => <KeepLabPage mode="plain" page="a" />,
        { name: "plain.a" },
        () => [loader(KeepLabALoader)],
      ),
      path(
        "/plain/b",
        () => <KeepLabPage mode="plain" page="b" />,
        { name: "plain.b" },
        () => [loader(KeepLabBLoader)],
      ),
      path(
        "/plain/c",
        () => <KeepLabPage mode="plain" page="c" />,
        { name: "plain.c" },
        () => [loader(KeepLabCLoader)],
      ),
    ],
  ),
  layout(
    () => <KeepLabLayout mode="transition" />,
    () => [
      transition(),
      path(
        "/transition/a",
        () => <KeepLabPage mode="transition" page="a" />,
        { name: "transition.a" },
        () => [loader(KeepLabALoader)],
      ),
      path(
        "/transition/b",
        () => <KeepLabPage mode="transition" page="b" />,
        { name: "transition.b" },
        () => [loader(KeepLabBLoader)],
      ),
      path(
        "/transition/c",
        () => <KeepLabPage mode="transition" page="c" />,
        { name: "transition.c" },
        () => [loader(KeepLabCLoader)],
      ),
    ],
  ),
  layout(
    () => <KeepLabLayout mode="keep" />,
    () => [
      path(
        "/keep/a",
        () => <KeepLabPage mode="keep" page="a" />,
        { name: "keep.a" },
        () => [loader(KeepLabALoader)],
      ),
      path(
        "/keep/b",
        () => <KeepLabPage mode="keep" page="b" />,
        { name: "keep.b" },
        () => [loader(KeepLabBLoader)],
      ),
      path(
        "/keep/c",
        () => <KeepLabPage mode="keep" page="c" />,
        { name: "keep.c" },
        () => [loader(KeepLabCLoader)],
      ),
    ],
  ),
  layout(
    () => <KeepLabLayout mode="keep-two-step" />,
    () => [
      path(
        "/keep-two-step/a",
        () => <KeepLabPage mode="keep-two-step" page="a" />,
        { name: "keepTwoStep.a" },
        () => [loader(KeepLabALoader)],
      ),
      path(
        "/keep-two-step/b",
        () => <KeepLabPage mode="keep-two-step" page="b" />,
        { name: "keepTwoStep.b" },
        () => [loader(KeepLabBLoader)],
      ),
      path(
        "/keep-two-step/c",
        () => <KeepLabPage mode="keep-two-step" page="c" />,
        { name: "keepTwoStep.c" },
        () => [loader(KeepLabCLoader)],
      ),
    ],
  ),
]);
