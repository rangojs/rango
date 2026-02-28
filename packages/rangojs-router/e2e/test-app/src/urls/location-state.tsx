import { urls, redirect } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { FlashMessage, ServerInfo } from "../location-states.js";
import {
  FlashBanner,
  ServerInfoDisplay,
  ActionRedirectButton,
  ActionSimpleRedirectButton,
  ThrowRedirectButton,
  ThrowSimpleRedirectButton,
} from "../components/FlashBanner.js";

/**
 * Location state test routes - tests for redirect() with state,
 * ctx.setLocationState(), useLocationState(), and useLocationState()
 */
export const locationStatePatterns = urls(({ path, middleware }) => [
  // Index page with links to trigger different scenarios
  path(
    "/",
    () => (
      <div data-testid="ls-index">
        <h1>Location State Tests</h1>
        <FlashBanner />
        <ServerInfoDisplay />
        <ul>
          <li>
            <Link
              to="/location-state/trigger-redirect"
              data-testid="ls-redirect-link"
            >
              Trigger redirect with flash
            </Link>
          </li>
          <li>
            <Link
              to="/location-state/trigger-ctx-state"
              data-testid="ls-ctx-state-link"
            >
              Trigger ctx.setLocationState
            </Link>
          </li>
          <li>
            <Link
              to="/location-state/mw-redirect"
              data-testid="ls-mw-redirect-link"
            >
              Trigger middleware redirect with flash
            </Link>
          </li>
          <li>
            <Link
              to="/location-state/redirect-303"
              data-testid="ls-redirect-303-link"
            >
              Trigger 303 redirect with flash
            </Link>
          </li>
          <li>
            <Link to="/location-state/other" data-testid="ls-other-link">
              Go to other page
            </Link>
          </li>
        </ul>
        <ActionRedirectButton />
        <ActionSimpleRedirectButton />
        <ThrowRedirectButton />
        <ThrowSimpleRedirectButton />
      </div>
    ),
    { name: "index" },
  ),

  // Handler that redirects back to index with flash state
  path(
    "/trigger-redirect",
    (ctx) => {
      return redirect("/location-state", {
        state: [FlashMessage({ text: "Item saved successfully!" })],
      });
    },
    { name: "triggerRedirect" },
  ),

  // Handler that renders a page using ctx.setLocationState (non-redirect)
  path(
    "/trigger-ctx-state",
    (ctx) => {
      ctx.setLocationState([ServerInfo({ data: "server-set-value" })]);
      return (
        <div data-testid="ls-ctx-state-page">
          <h1>Page with server-set state</h1>
          <ServerInfoDisplay />
          <Link to="/location-state" data-testid="ls-back-link">
            Back to index
          </Link>
        </div>
      );
    },
    { name: "triggerCtxState" },
  ),

  // Target page for redirect with state + flash via middleware redirect
  path(
    "/target",
    () => (
      <div data-testid="ls-target">
        <h1>Redirect target</h1>
        <FlashBanner />
        <Link to="/location-state" data-testid="ls-back-link">
          Back to index
        </Link>
      </div>
    ),
    { name: "target" },
  ),

  // Middleware redirect with state to /target
  path(
    "/mw-redirect",
    () => <div>Should not render</div>,
    { name: "mwRedirect" },
    () => [
      middleware(async (ctx, next) => {
        return redirect("/location-state/target", {
          state: [FlashMessage({ text: "Redirected by middleware!" })],
        });
      }),
    ],
  ),

  // Redirect with custom status
  path(
    "/redirect-303",
    (ctx) => {
      return redirect("/location-state/target", {
        status: 303,
        state: [FlashMessage({ text: "303 redirect flash" })],
      });
    },
    { name: "redirect303" },
  ),

  // Other page (for testing flash clears on navigation)
  path(
    "/other",
    () => (
      <div data-testid="ls-other-page">
        <h1>Other page</h1>
        <FlashBanner />
        <Link to="/location-state" data-testid="ls-back-link">
          Back to index
        </Link>
      </div>
    ),
    { name: "other" },
  ),
]);
