import type { HandlerContext } from "@rangojs/router";

export function ProtectedIndexPage(ctx: HandlerContext) {
  return (
    <div>
      <h2>Protected Area</h2>
      <p>You are authenticated!</p>
      <p>URL: {ctx.pathname}</p>
      <p>
        <a href="/">Back to home</a>
      </p>
    </div>
  );
}

export function ProtectedDashboardPage() {
  return (
    <div>
      <h2>Dashboard</h2>
      <p>Protected dashboard content</p>
    </div>
  );
}

export function ProtectedProfilePage(
  ctx: HandlerContext<{ username: string }>,
) {
  return (
    <div>
      <h2>Profile: {ctx.params.username}</h2>
      <p>Protected profile page</p>
    </div>
  );
}
