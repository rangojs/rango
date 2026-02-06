import { urls } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import {
  AdminIndexPage,
  AdminUsersPage,
  AdminUserPage,
  AdminSettingsPage,
  globalRevalidation,
  userRevalidation,
  settingsRevalidation,
} from "../pages/admin.js";

export const adminPatterns = urls(({ path, layout, revalidate }) => [
  // Passthrough layout for global revalidation
  layout(<Outlet />, () => [
    revalidate(globalRevalidation),
    path("/", AdminIndexPage, { name: "index" }),
    path("/users", AdminUsersPage, { name: "users" }),
    path("/users/:id", AdminUserPage, { name: "user" }, () => [
      revalidate(userRevalidation),
    ]),
    path("/settings", AdminSettingsPage, { name: "settings" }, () => [
      revalidate(settingsRevalidation),
    ]),
  ]),
]);
