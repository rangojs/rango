import { urls } from "@rangojs/router";
import { Meta, type HandlerContext } from "@rangojs/router";
import { AdminLayout } from "./components/AdminLayout.js";

function DashboardPage(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "Dashboard - Admin" });

  return (
    <main data-testid="admin-dashboard-page">
      <h1 data-testid="admin-dashboard-title">Admin Dashboard</h1>
      <p>Welcome to the admin panel.</p>
    </main>
  );
}

function UsersPage(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "Users - Admin" });

  return (
    <main data-testid="admin-users-page">
      <h1 data-testid="admin-users-title">Users</h1>
      <p>Manage your users here.</p>
    </main>
  );
}

export const adminPatterns = urls(({ path, layout, include }) => [
  layout(<AdminLayout />, () => [
    path("/", DashboardPage, { name: "home" }),
    path("/users", UsersPage, { name: "users" }),
    // Async include: the /api group is code-split, loaded on the first /api/*
    // request into this host-mounted admin router.
    include("/api", () => import("./api.js"), { name: "api" }),
  ]),
]);
