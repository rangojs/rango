import { urls } from "@rangojs/router";
import { ClientPackageResolutionConsumer } from "../components/ClientPackageResolutionConsumer.js";
import { ClientPackageResolutionLayout } from "../components/layouts/ClientPackageResolutionLayout.js";

export const clientPackageResolutionPatterns = urls(({ path, layout }) => [
  layout(ClientPackageResolutionLayout, () => [
    path("/", () => <ClientPackageResolutionConsumer />, {
      name: "clientPackageResolutionIndex",
    }),
  ]),
]);
