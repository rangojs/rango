import { map } from "@rangojs/router/server";
import type { aboutRoutes } from "../routes.js";
import { Outlet } from "@rangojs/router/client";
import { DebugSegmentWrapper } from "../components/DebugSegmentWrapper.js";

/**
 * About handlers - array-based API with use() pattern
 * Note: RootLayout is now used as the document component in router.tsx
 */
export default map<typeof aboutRoutes>(({ route, layout }) => [
  layout(
    <DebugSegmentWrapper type="layout" name="Test">
      <div>
        test
        <Outlet />
      </div>
    </DebugSegmentWrapper>
  ),

  route("about.index", () => (
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
  )),
]);
