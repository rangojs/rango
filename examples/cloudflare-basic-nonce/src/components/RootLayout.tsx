import { Outlet } from "rsc-router/client";

export function RootLayout() {
  return (
    <>
      <nav>
        <a href="/">Home</a>
        <a href="/about">About</a>
        <a href="/counter">Counter</a>
      </nav>
      <Outlet />
    </>
  );
}
