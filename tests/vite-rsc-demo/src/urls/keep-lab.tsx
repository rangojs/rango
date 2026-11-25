import { urls, Meta } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { KeepLabLayout, KeepLabPage } from "./keep-lab.client.js";
import {
  KeepLabModalSkeleton,
  KeepLabItemModal,
  KeepLabItemPage,
  KeepLabPanel,
} from "./keep-lab-slots.client.js";
import {
  KeepLabALoader,
  KeepLabBLoader,
  KeepLabCLoader,
  KeepLabLayoutLoader,
  KeepLabItemLoader,
  KeepLabPanelLoader,
} from "./keep-lab.loaders.js";
import { KEEP_LAB_MODES } from "./keep-lab.modes.js";

// SPIKE (keep lab): kept pages side by side. Modes 1 to 4 are server routes
// here; mode 5 is the clientUrls() group in keep-lab-group.client.tsx.

function KeepLabIndex() {
  return (
    <main>
      <h1>Keep lab</h1>
      <p>
        The same three pages, each with a slow loader whose read number and time
        change on every read, a pushed title and crumb, a text input, an
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
export const keepLabPatterns = urls(
  ({ path, layout, loader, loading, transition, parallel, intercept }) => [
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
        loader(KeepLabLayoutLoader),
        intercept(
          "@modal",
          ".plain.item",
          <KeepLabItemModal mode="plain" />,
          () => [loader(KeepLabItemLoader), loading(<KeepLabModalSkeleton />)],
        ),
        path(
          "/plain/item/:id",
          () => <KeepLabItemPage mode="plain" />,
          { name: "plain.item" },
          () => [loader(KeepLabItemLoader), loading(<KeepLabModalSkeleton />)],
        ),
        path(
          "/plain/a",
          () => <KeepLabPage mode="plain" page="a" />,
          { name: "plain.a" },
          () => [
            loader(KeepLabALoader),
            parallel(
              { "@panel": () => <KeepLabPanel mode="plain" page="a" /> },
              () => [loader(KeepLabPanelLoader)],
            ),
          ],
        ),
        path(
          "/plain/b",
          () => <KeepLabPage mode="plain" page="b" />,
          { name: "plain.b" },
          () => [
            loader(KeepLabBLoader),
            parallel(
              { "@panel": () => <KeepLabPanel mode="plain" page="b" /> },
              () => [loader(KeepLabPanelLoader)],
            ),
          ],
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
        loader(KeepLabLayoutLoader),
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
        loader(KeepLabLayoutLoader),
        intercept(
          "@modal",
          ".keep.item",
          <KeepLabItemModal mode="keep" />,
          () => [loader(KeepLabItemLoader), loading(<KeepLabModalSkeleton />)],
        ),
        path(
          "/keep/item/:id",
          () => <KeepLabItemPage mode="keep" />,
          { name: "keep.item" },
          () => [loader(KeepLabItemLoader), loading(<KeepLabModalSkeleton />)],
        ),
        path(
          "/keep/a",
          () => <KeepLabPage mode="keep" page="a" />,
          { name: "keep.a" },
          () => [
            loader(KeepLabALoader),
            parallel(
              { "@panel": () => <KeepLabPanel mode="keep" page="a" /> },
              () => [loader(KeepLabPanelLoader)],
            ),
          ],
        ),
        path(
          "/keep/b",
          () => <KeepLabPage mode="keep" page="b" />,
          { name: "keep.b" },
          () => [
            loader(KeepLabBLoader),
            parallel(
              { "@panel": () => <KeepLabPanel mode="keep" page="b" /> },
              () => [loader(KeepLabPanelLoader)],
            ),
          ],
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
        loader(KeepLabLayoutLoader),
        intercept(
          "@modal",
          ".keepTwoStep.item",
          <KeepLabItemModal mode="keep-two-step" />,
          () => [loader(KeepLabItemLoader), loading(<KeepLabModalSkeleton />)],
        ),
        path(
          "/keep-two-step/item/:id",
          () => <KeepLabItemPage mode="keep-two-step" />,
          { name: "keepTwoStep.item" },
          () => [loader(KeepLabItemLoader), loading(<KeepLabModalSkeleton />)],
        ),
        path(
          "/keep-two-step/a",
          () => <KeepLabPage mode="keep-two-step" page="a" />,
          { name: "keepTwoStep.a" },
          () => [
            loader(KeepLabALoader),
            parallel(
              {
                "@panel": () => <KeepLabPanel mode="keep-two-step" page="a" />,
              },
              () => [loader(KeepLabPanelLoader)],
            ),
          ],
        ),
        path(
          "/keep-two-step/b",
          () => <KeepLabPage mode="keep-two-step" page="b" />,
          { name: "keepTwoStep.b" },
          () => [
            loader(KeepLabBLoader),
            parallel(
              {
                "@panel": () => <KeepLabPanel mode="keep-two-step" page="b" />,
              },
              () => [loader(KeepLabPanelLoader)],
            ),
          ],
        ),
        path(
          "/keep-two-step/c",
          () => <KeepLabPage mode="keep-two-step" page="c" />,
          { name: "keepTwoStep.c" },
          () => [loader(KeepLabCLoader)],
        ),
      ],
    ),
  ],
);
