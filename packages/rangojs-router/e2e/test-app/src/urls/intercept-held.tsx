import { redirect, urls } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { Modal } from "../components/Modal.js";
import {
  InterceptHeldCrumbsBar,
  InterceptHeldLoaderModal,
  InterceptHeldMixedModal,
  InterceptHeldPushModal,
  InterceptHeldRedirectButton,
  InterceptPushModal,
} from "./intercept-held.client.js";
import {
  InterceptHeldCrumbs,
  InterceptHeldLoader,
  InterceptHeldPushLoader,
  InterceptPushLoader,
  InterceptRerunLoader,
  readRedirectWrites,
} from "./intercept-held.defs.js";

// e2e/intercept-held.test.ts (tests/shared-e2e intercept-held-scenario). One
// layout with a @modal slot and seven intercepted routes, each opened from the
// index page:
//  - /loader/:id  the modal's only loader skips revalidate() (a server action
//                 called from the open modal must leave the modal on its
//                 loader data);
//  - /rerun/:id   control: the same modal, its loader following the default;
//  - /mixed/:id   one loader held, one following the default;
//  - /push/:id    the modal's loader pushes a crumb;
//  - /handler/:id the modal's handler pushes a crumb;
//  - /push-held/:id the modal's handler pushes a crumb, and its loader,
//                 which skips revalidate(), pushes one.
//  - /deferred/:id the intercept's handler pushes a crumb whose value resolves
//                 late (a deferred handle value).
// The index page also has a button whose server action redirects to
// /handler/1, and a link to /redirect, whose handler redirects there. The
// index pushes an "index" crumb and shows how many times that action ran; the
// /handler intercept links back to the index.
// The /mixed modal links to /loader/1: both modals read the held loader.
// The /handler intercept and its full page link to /away, which no
// intercept targets (intercept-history-scenario).
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
      <p data-testid="ih-index-writes">{readRedirectWrites()}</p>
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
      <Link
        to="/intercept-held/push-held/1"
        prefetch="none"
        data-testid="ih-open-push-held"
      >
        Open held-loader-push modal
      </Link>
      <Link
        to="/intercept-held/deferred/1"
        prefetch="none"
        data-testid="ih-open-deferred"
      >
        Open deferred-push intercept
      </Link>
      <InterceptHeldRedirectButton />
      <Link
        to="/intercept-held/redirect"
        prefetch="none"
        data-testid="ih-link-redirect"
      >
        Link to a route that redirects to an intercepted route
      </Link>
    </div>
  );
}

// Taller than the viewport, so a scroll offset shows.
const TALL = { height: "300vh" };

// A page no intercept targets; its link steps `?n`, one history entry per
// click (intercept-history-scenario).
function InterceptHeldAway({ n }: { n: number }) {
  return (
    <div data-testid="ih-away" style={TALL}>
      <span data-testid="ih-away-n">{n}</span>
      <Link
        to={`/intercept-held/away?n=${n + 1}`}
        prefetch="none"
        data-testid="ih-away-next"
      >
        Next
      </Link>
    </div>
  );
}

function InterceptHeldHandlerPage() {
  return (
    <div data-testid="ih-handler-page" style={TALL}>
      full page
      <Link
        to="/intercept-held/away?n=1"
        prefetch="none"
        data-testid="ih-handler-page-away"
      >
        Away
      </Link>
    </div>
  );
}

const FullPage = (testId: string) =>
  function InterceptHeldFullPage() {
    return <div data-testid={testId}>full page</div>;
  };

// How late the /deferred intercept's crumb resolves: long enough to leave
// the intercept before it lands.
const DEFERRED_PUSH_MS = 2000;

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
        path(
          "/",
          (ctx) => {
            ctx.use(InterceptHeldCrumbs)("index");
            return <InterceptHeldIndex />;
          },
          { name: "index" },
        ),

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
          () => [loader(InterceptHeldLoader, () => [revalidate(false)])],
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
            loader(InterceptHeldLoader, () => [revalidate(false)]),
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

        path("/push-held/:id", FullPage("ih-push-held-page"), {
          name: "pushHeldItem",
        }),
        intercept(
          "@modal",
          ".pushHeldItem",
          (ctx) => {
            const renders = ++modalRenders;
            ctx.use(InterceptHeldCrumbs)(
              `held-handler:${ctx.params.id}:${renders}`,
            );
            return (
              <InterceptHeldPushModal id={ctx.params.id} renders={renders} />
            );
          },
          () => [
            loader(InterceptHeldPushLoader, () => [revalidate(() => false)]),
          ],
        ),

        path("/redirect", () => {
          throw redirect("/intercept-held/handler/1");
        }),
        path("/deferred/:id", FullPage("ih-deferred-page"), {
          name: "deferredItem",
        }),
        intercept("@modal", ".deferredItem", (ctx) => {
          const id = ctx.params.id;
          ctx.use(InterceptHeldCrumbs)(
            new Promise<string>((resolve) =>
              setTimeout(() => resolve(`deferred:${id}`), DEFERRED_PUSH_MS),
            ),
          );
          return (
            <Modal testId="ih-deferred-intercept">
              <p data-testid="ih-deferred-intercept-id">{id}</p>
            </Modal>
          );
        }),

        path(
          "/away",
          (ctx) => (
            <InterceptHeldAway n={Number(ctx.searchParams.get("n") ?? 0)} />
          ),
          { name: "away" },
        ),

        path("/handler/:id", InterceptHeldHandlerPage, {
          name: "handlerItem",
        }),
        intercept("@modal", ".handlerItem", (ctx) => {
          ctx.use(InterceptHeldCrumbs)(`modal-handler:${ctx.params.id}`);
          return (
            <Modal testId="ih-handler-modal">
              <p data-testid="ih-handler-modal-id">{ctx.params.id}</p>
              <Link
                to="/intercept-held"
                prefetch="none"
                data-testid="ih-handler-intercept-to-index"
              >
                Close
              </Link>
              <Link
                to="/intercept-held/away?n=1"
                prefetch="none"
                data-testid="ih-handler-intercept-away"
              >
                Away
              </Link>
            </Modal>
          );
        }),
      ],
    ),
  ],
);
