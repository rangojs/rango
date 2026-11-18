import { Breadcrumbs, Meta, urls, type HandlerContext } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import {
  PushHandleChat,
  PushHandleHead,
  PushHandleProject,
} from "./push-handle.client.js";

function PushHandleLayout(ctx: HandlerContext) {
  ctx.use(Breadcrumbs)({ label: "PH", href: "/push-handle" });
  return (
    <div>
      <PushHandleHead />
      <Outlet />
    </div>
  );
}

/**
 * Client components push handle values with usePushHandle (e2e
 * push-handle.test.ts, scenario in tests/shared-e2e/src/push-handle-scenario.ts).
 * Each route pushes the title its first paint shows on the server.
 */
export const pushHandlePatterns = urls(({ path, layout }) => [
  layout(PushHandleLayout, () => [
    path(
      "/push-handle/project",
      (ctx) => {
        ctx.use(Meta)({ title: "PH Project" });
        ctx.use(Breadcrumbs)({
          label: "Project",
          href: "/push-handle/project",
        });
        return <PushHandleProject />;
      },
      { name: "pushHandleProject" },
    ),
    path(
      "/push-handle/chat",
      (ctx) => {
        ctx.use(Meta)({ title: "PH Chat" });
        return <PushHandleChat />;
      },
      { name: "pushHandleChat" },
    ),
  ]),
]);
