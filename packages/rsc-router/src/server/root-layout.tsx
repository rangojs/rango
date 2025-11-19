import type { ReactNode } from "react";
import { Outlet } from "rsc-router/client";

const RootLayout = (
  <>
    <Outlet />
  </>
) as ReactNode;

export default RootLayout;
