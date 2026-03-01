import { urls } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { ActionRedirectAuthLoader } from "../loaders.js";
import { ActionRedirectLoginForm } from "../components/ActionRedirectLoginForm.js";

/**
 * Action redirect revalidation test routes.
 * Tests that after a server action sets a cookie and throws redirect(),
 * the target route's loaders run fresh (not from stale cache).
 */
export const actionRedirectRevalidationPatterns = urls(({ path, loader }) => [
  // Main page — shows auth status from loader
  path(
    "/",
    async (ctx) => {
      const { user, loadedAt } = await ctx.use(ActionRedirectAuthLoader);
      return (
        <div data-testid="action-redirect-page">
          <h1 data-testid="action-redirect-title">
            Action Redirect Revalidation Test
          </h1>
          <div data-testid="auth-status">
            {user ? (
              <span data-testid="auth-user">Logged in as: {user}</span>
            ) : (
              <span data-testid="auth-guest">Guest</span>
            )}
          </div>
          <p data-testid="auth-loaded-at">Loaded: {loadedAt}</p>
          <Link
            to="/action-redirect-revalidation/login"
            data-testid="go-to-login"
          >
            Go to Login
          </Link>
        </div>
      );
    },
    { name: "index" },
    () => [loader(ActionRedirectAuthLoader)],
  ),

  // Login page — form that triggers action redirect
  path(
    "/login",
    () => (
      <div data-testid="action-redirect-login-page">
        <h1>Login</h1>
        <ActionRedirectLoginForm />
        <Link to="/action-redirect-revalidation" data-testid="back-link">
          Back
        </Link>
      </div>
    ),
    { name: "login" },
  ),
]);
