import type { ReactNode } from "react";
import { Outlet } from "../client.js";

const MapRootLayout = (
  <>
    <Outlet />
  </>
) as ReactNode;

export default MapRootLayout;
