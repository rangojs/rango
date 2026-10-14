import { urls } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import {
  TransitionKindsAction,
  TransitionKindsProbe,
  type TransitionKindsProbeKind,
} from "../components/TransitionKindsProbe.js";

/**
 * #1165: every commit the router runs in a transition carries its
 * transition({ when }) kind as a transition type. /vt-kinds/<variant>/* pages
 * differ only in transition() and in the probe <ViewTransition> they render
 * (components/TransitionKindsProbe.tsx):
 *
 * - log: transition({ viewTransition: false }), so every navigation holds;
 *   the probe records every commit's types.
 * - log-vt: log under transition(), with the router's <ViewTransition>.
 * - hold: no transition(); a search or catch-all change is the same-structure
 *   content hold. The probe records every commit's types. revalidate() makes
 *   a stale entry's background revalidation re-render the page.
 * - push: transition({ viewTransition: false }); the probe animates push only.
 * - push-vt: push under transition(), with the router's <ViewTransition>.
 * - legacy: no transition(); the probe keys only `navigation`, a type that
 *   existed before #1165.
 * - route-push: the router's own <ViewTransition>, whose map animates push
 *   only. No probe.
 *
 * The stamp changes on every server render, so each commit changes the page.
 */
function TransitionKindsPage({
  url,
  variant,
  probe,
}: {
  url: URL;
  variant: string;
  probe?: TransitionKindsProbeKind;
}) {
  const stamp = Math.random().toString(36).slice(2, 10);
  const base = `/vt-kinds/${variant}`;
  return (
    <div data-testid="vt-kinds-page">
      <span data-testid="vt-kinds-path">{url.pathname + url.search}</span>
      {probe ? (
        <TransitionKindsProbe probe={probe} stamp={stamp} />
      ) : (
        <span data-testid="vt-kinds-stamp">{stamp}</span>
      )}
      <Link to={`${base}/b`} data-testid="vt-kinds-push" prefetch="none">
        push
      </Link>
      <Link
        to={`${base}/c`}
        replace
        data-testid="vt-kinds-replace"
        prefetch="none"
      >
        replace
      </Link>
      <Link to={`${base}/c?q=1`} data-testid="vt-kinds-search" prefetch="none">
        search
      </Link>
      <TransitionKindsAction />
    </div>
  );
}

export const transitionKindsPatterns = urls(
  ({ path, revalidate, transition }) => [
    path(
      "/vt-kinds/log/*",
      (ctx) => <TransitionKindsPage url={ctx.url} variant="log" probe="log" />,
      { name: "vtKindsLog" },
      () => [transition({ viewTransition: false })],
    ),
    path(
      "/vt-kinds/log-vt/*",
      (ctx) => (
        <TransitionKindsPage url={ctx.url} variant="log-vt" probe="log" />
      ),
      { name: "vtKindsLogVt" },
      () => [transition()],
    ),
    path(
      "/vt-kinds/hold/*",
      (ctx) => <TransitionKindsPage url={ctx.url} variant="hold" probe="log" />,
      { name: "vtKindsHold" },
      // A background revalidation of the same URL re-renders the page.
      () => [revalidate(() => true)],
    ),
    path(
      "/vt-kinds/push/*",
      (ctx) => (
        <TransitionKindsPage url={ctx.url} variant="push" probe="push" />
      ),
      { name: "vtKindsPush" },
      () => [transition({ viewTransition: false })],
    ),
    path(
      "/vt-kinds/push-vt/*",
      (ctx) => (
        <TransitionKindsPage url={ctx.url} variant="push-vt" probe="push" />
      ),
      { name: "vtKindsPushVt" },
      () => [transition()],
    ),
    path(
      "/vt-kinds/legacy/*",
      (ctx) => (
        <TransitionKindsPage url={ctx.url} variant="legacy" probe="legacy" />
      ),
      { name: "vtKindsLegacy" },
    ),
    path(
      "/vt-kinds/route-push/*",
      (ctx) => <TransitionKindsPage url={ctx.url} variant="route-push" />,
      { name: "vtKindsRoutePush" },
      () => [
        transition({
          default: { push: "vt-kinds-push", default: "none" },
        }),
      ],
    ),
  ],
);
