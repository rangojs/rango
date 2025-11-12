import { map, route } from "rsc-router";
import type { aboutRoutes } from "../routes.js";
import { RootLayout } from "../layouts/RootLayout.js";
import { Outlet } from "rsc-router/client";

/**
 * About handlers
 */
export default map<typeof aboutRoutes, { test: true }>({
  [route.layout]: <RootLayout />,
  [route.layout]: (
    <>
      test
      <Outlet />{" "}
    </>
  ),
  // [route.layout]:false,
  index: () => (
    <div>
      <h1>ℹ️ About</h1>
      <p className="segment-id">Segment: About Route</p>
      <p>This is a minimal RSC Router demo application.</p>
      <p>
        <a href="/">← Back to home</a>
      </p>
    </div>
  ),
});
