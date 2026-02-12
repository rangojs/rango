"use client";

import { Link, Outlet } from "@rangojs/router/client";

export function AdminLayout() {
  return (
    <>
      <nav data-testid="admin-nav">
        <Link to="/" data-testid="admin-nav-dashboard">
          Dashboard
        </Link>
        <Link to="/users" data-testid="admin-nav-users">
          Users
        </Link>
      </nav>
      <Outlet />
    </>
  );
}
