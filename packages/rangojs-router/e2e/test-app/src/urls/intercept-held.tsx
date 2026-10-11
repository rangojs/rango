import { urls } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { Modal } from "../components/Modal.js";
import {
  InterceptHeldCrumbsBar,
  InterceptHeldLoaderModal,
  InterceptHeldMixedModal,
  InterceptPushModal,
} from "./intercept-held.client.js";
import {
  InterceptHeldCrumbs,
  InterceptHeldLoader,
  InterceptPushLoader,
  InterceptRerunLoader,
} from "./intercept-held.defs.js";

// e2e/intercept-held.test.ts (tests/shared-e2e intercept-held-scenario). One
// layout with a @modal slot and five intercepted routes, each opened from the
// index page:
//  - /loader/:id  the modal's only loader skips revalidate() (a server action
//                 called from the open modal must leave the modal on its
//                 loader data);
//  - /rerun/:id   control: the same modal, its loader following the default;
//  - /mixed/:id   one loader held, one following the default;
//  - /push/:id    the modal's loader pushes a crumb;
//  - /handler/:id the modal's handler pushes a crumb.
// The layout shows the crumb handle; it pushes "layout" itself.
function InterceptHeldLayout() {
  return (
    <div data-testid="ih-layout">
      <InterceptHeldCrumbsBar />
      <Outlet />
      <Outlet name="@modal" />
    </div>
  );
}

function InterceptHeldIndex() {
  return (
    <div data-testid="ih-index">
      <Link
        to="/intercept-held/loader/1"
        prefetch="none"
        data-testid="ih-open-loader"
      >
        Open held-loader modal
      </Link>
      <Link
        to="/intercept-held/rerun/1"
        prefetch="none"
        data-testid="ih-open-rerun"
      >
        Open default-revalidation modal
      </Link>
      <Link
        to="/intercept-held/mixed/1"
        prefetch="none"
        data-testid="ih-open-mixed"
      >
        Open mixed-revalidation modal
      </Link>
      <Link
        to="/intercept-held/push/1"
        prefetch="none"
        data-testid="ih-open-push"
      >
        Open loader-push modal
      </Link>
      <Link
        to="/intercept-held/handler/1"
        prefetch="none"
        data-testid="ih-open-handler"
      >
        Open handler-push modal
      </Link>
    </div>
  );
}

const FullPage = (testId: string) =>
  function InterceptHeldFullPage() {
    return <div data-testid={testId}>full page</div>;
  };

// Server renders of the held-loader modal's handler: it re-runs on every
// action that reaches the slot, so a change here is the signal that the
// response was applied.
let modalRenders = 0;

export const interceptHeldPatterns = urls(
  ({ path, layout, intercept, loader, revalidate }) => [
    layout(
      (ctx) => {
        ctx.use(InterceptHeldCrumbs)("layout");
        return <InterceptHeldLayout />;
      },
      () => [
        path("/", InterceptHeldIndex, { name: "index" }),

        path("/loader/:id", FullPage("ih-loader-page"), {
          name: "loaderItem",
        }),
        intercept(
          "@modal",
          ".loaderItem",
          (ctx) => (
            <InterceptHeldLoaderModal
              id={ctx.params.id}
              renders={++modalRenders}
              loader={InterceptHeldLoader}
            />
          ),
          () => [loader(InterceptHeldLoader, () => [revalidate(() => false)])],
        ),

        path("/rerun/:id", FullPage("ih-rerun-page"), { name: "rerunItem" }),
        intercept(
          "@modal",
          ".rerunItem",
          (ctx) => (
            <InterceptHeldLoaderModal
              id={ctx.params.id}
              renders={++modalRenders}
              loader={InterceptRerunLoader}
            />
          ),
          () => [loader(InterceptRerunLoader)],
        ),

        path("/mixed/:id", FullPage("ih-mixed-page"), { name: "mixedItem" }),
        intercept(
          "@modal",
          ".mixedItem",
          (ctx) => (
            <InterceptHeldMixedModal
              id={ctx.params.id}
              renders={++modalRenders}
            />
          ),
          () => [
            loader(InterceptHeldLoader, () => [revalidate(() => false)]),
            loader(InterceptRerunLoader),
          ],
        ),

        path("/push/:id", FullPage("ih-push-page"), { name: "pushItem" }),
        intercept(
          "@modal",
          ".pushItem",
          (ctx) => <InterceptPushModal id={ctx.params.id} />,
          () => [loader(InterceptPushLoader)],
        ),

        path("/handler/:id", FullPage("ih-handler-page"), {
          name: "handlerItem",
        }),
        intercept("@modal", ".handlerItem", (ctx) => {
          ctx.use(InterceptHeldCrumbs)(`modal-handler:${ctx.params.id}`);
          return (
            <Modal testId="ih-handler-modal">
              <p data-testid="ih-handler-modal-id">{ctx.params.id}</p>
            </Modal>
          );
        }),
      ],
    ),
  ],
);
