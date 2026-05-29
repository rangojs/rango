import { urls, redirect } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import {
  FlashMessage,
  ServerInfo,
  SlowProductLocationState,
} from "../location-states.js";
import {
  FlashBanner,
  ServerInfoDisplay,
  ActionRedirectButton,
  ActionSimpleRedirectButton,
  ThrowRedirectButton,
  ThrowSimpleRedirectButton,
  ThrowErrorButton,
  ThrowFormErrorButton,
} from "../components/FlashBanner.js";
import {
  TypedStateDisplay,
  PlainStateDisplay,
  TypedJitLink,
  PlainJitLink,
  TypedJitTimingLink,
} from "../components/LinkStateDisplay.js";
import { StaticWriteWidget } from "../components/StaticWriteWidget.js";

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
        <ThrowErrorButton />
        <ThrowFormErrorButton />
      </div>
    ),
    { name: "index" },
  ),

  // Handler that redirects back to index with flash state
  path(
    "/trigger-redirect",
    (ctx) => {
      return redirect("/location-state", {
        state: FlashMessage({ text: "Item saved successfully!" }),
      });
    },
    { name: "triggerRedirect" },
  ),

  // Handler that renders a page using ctx.setLocationState (non-redirect)
  path(
    "/trigger-ctx-state",
    (ctx) => {
      ctx.setLocationState(ServerInfo({ data: "server-set-value" }));
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
          state: FlashMessage({ text: "Redirected by middleware!" }),
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
        state: FlashMessage({ text: "303 redirect flash" }),
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

  // === Link state prop tests ===
  // Tests for all 4 state patterns: typed eager, typed JIT, plain static, plain JIT

  // Link state index page with links exercising each pattern
  path(
    "/link-state",
    () => (
      <div data-testid="link-state-index">
        <h1>Link State Prop Tests</h1>
        <ul>
          <li>
            <Link
              to="/location-state/link-state/target"
              state={[
                SlowProductLocationState({
                  productName: "Eager Product",
                  productPrice: 42,
                }),
              ]}
              data-testid="link-typed-eager"
            >
              Typed eager state
            </Link>
          </li>
          <li>
            <TypedJitLink />
          </li>
          <li>
            <Link
              to="/location-state/link-state/plain-target"
              state={{ from: "list", count: 5 }}
              data-testid="link-plain-static"
            >
              Plain static state
            </Link>
          </li>
          <li>
            <PlainJitLink />
          </li>
          <li>
            <TypedJitTimingLink />
          </li>
        </ul>
      </div>
    ),
    { name: "linkState" },
  ),

  // Target page for typed state (reads via useLocationState with definition)
  path(
    "/link-state/target",
    () => (
      <div data-testid="link-state-target">
        <h1>Typed State Target</h1>
        <TypedStateDisplay />
        <Link to="/location-state/link-state" data-testid="link-state-back">
          Back
        </Link>
      </div>
    ),
    { name: "linkStateTarget" },
  ),

  // Target page for plain state (reads via useLocationState without definition)
  path(
    "/link-state/plain-target",
    () => (
      <div data-testid="link-state-plain-target">
        <h1>Plain State Target</h1>
        <PlainStateDisplay />
        <Link to="/location-state/link-state" data-testid="link-state-back">
          Back
        </Link>
      </div>
    ),
    { name: "linkStatePlainTarget" },
  ),

  // Static write/delete demo: drives LocationState.write() and .delete()
  // from the client and exposes both .read() and useLocationState() readers.
  path(
    "/static-write",
    () => (
      <div data-testid="ls-static-write">
        <h1>Static Write</h1>
        <StaticWriteWidget />
        <Link to="/location-state" data-testid="sw-index-link">
          Back to index
        </Link>
        <Link to="/location-state/other" data-testid="sw-other-link">
          Go to other page
        </Link>
      </div>
    ),
    { name: "staticWrite" },
  ),
]);
