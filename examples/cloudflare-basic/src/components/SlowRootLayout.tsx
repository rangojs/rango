import { Outlet } from "@ivogt/rsc-router/client";
import { NavigationProgress } from "./NavigationProgress.js";

export function RootLayout() {
  return (
    <>
      <NavigationProgress />
      <nav>
        Slow links {"->"} <a href="/slow/1">Slow 1</a>
        <a href="/slow/2">Slow 2</a>
      </nav>
      <Outlet />
    </>
  );
}
