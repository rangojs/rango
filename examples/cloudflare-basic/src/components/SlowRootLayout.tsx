import { Outlet } from "@rangojs/router/client";
import { NavigationProgress } from "./NavigationProgress.js";

export function RootLayout() {
  return (
    <>
      <NavigationProgress />
      <Outlet />
    </>
  );
}
