import { Outlet } from "@rangojs/router/client";
import { DeepContextServerWrapper } from "rango-e2e-deep-context-lib";
import type { ReactNode } from "react";
import { ClientPackageResolutionConsumer } from "../components/ClientPackageResolutionConsumer.js";

export function ClientPackageResolutionLayout(): ReactNode {
  return (
    <DeepContextServerWrapper value="deep-context-value">
      <Outlet />
    </DeepContextServerWrapper>
  );
}

export function ClientPackageResolutionPage(): ReactNode {
  return <ClientPackageResolutionConsumer />;
}
