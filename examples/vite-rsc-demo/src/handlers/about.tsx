import { map, route, layout } from "rsc-router";
import type { aboutRoutes } from "../routes.js";
import { RootLayout } from "../layouts/RootLayout.js";
import { Outlet } from "rsc-router/client";
import { DebugSegmentWrapper } from "../components/DebugSegmentWrapper.js";

/**
 * About handlers
 */
export default map<typeof aboutRoutes>({
  // Global layouts
  [layout("*", "root")]: () => <RootLayout />,
  [layout("*", "test")]: (
    <DebugSegmentWrapper type="layout" name="Test">
      <div>
        test
        <Outlet />
      </div>
    </DebugSegmentWrapper>
  ),

  [route("index")]: () => (
    <DebugSegmentWrapper type="route" name="About">
      <div>
        <h1>ℹ️ About</h1>
        <p className="segment-id">Segment: About Route</p>
        <p>This is a minimal RSC Router demo application.</p>
        <p>
          <a href="/">← Back to home</a>
        </p>
      </div>
    </DebugSegmentWrapper>
  ),
});
