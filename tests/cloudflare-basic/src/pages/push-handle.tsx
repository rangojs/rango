import { Breadcrumbs, Meta, urls, type HandlerContext } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import {
  PushHandleChat,
  PushHandleHead,
  PushHandleHeld,
  PushHandleProject,
  PushHandleStream,
} from "./push-handle.client.js";

// How long the "slow" held page answers late: React holds the page being
// left in the navigation's transition meanwhile.
const PH_HOLD = 3000;

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
export const pushHandlePatterns = urls(({ path, layout, transition }) => [
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
    path(
      "/push-handle/stream",
      (ctx) => {
        ctx.use(Meta)({ title: "PH Stream" });
        return <PushHandleStream />;
      },
      { name: "pushHandleStream" },
    ),
    path(
      "/push-handle/held/:id",
      async (ctx) => {
        const { id } = ctx.params;
        ctx.use(Meta)({ title: `PH Held ${id}` });
        if (id === "slow") {
          await new Promise((resolve) => setTimeout(resolve, PH_HOLD));
        }
        return <PushHandleHeld key={id} id={id} />;
      },
      { name: "pushHandleHeld" },
      () => [transition()],
    ),
  ]),
]);
