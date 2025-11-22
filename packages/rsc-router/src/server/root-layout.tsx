import type { ReactNode } from "react";
import { Outlet } from "rsc-router/client";

const MapRootLayout = (
  <>
    <Outlet />
  </>
) as ReactNode;

export default MapRootLayout;
