import { map } from "@ivogt/rsc-router/server";
import type { homeRoutes } from "../routes.js";
import { DebugSegmentWrapper } from "../components/DebugSegmentWrapper.js";
import { Outlet, ParallelOutlet } from "@ivogt/rsc-router/client";
import { TestGetLoaderComponent } from "../components/TestGetLoader.js";
// Import loader to ensure it registers on server
import "../loaders/test-get-loader.js";

/**
 * Home handlers - array-based API with use() pattern
 * Note: RootLayout is now used as the document component in router.tsx
 */
export default map<typeof homeRoutes>(
  ({ route, layout, revalidate, middleware, parallel }) => [
    route(
      "index",
      () => (
        <DebugSegmentWrapper type="route" name="Home">
          <div>
            <h1>🏠 Test</h1>
            <p className="segment-id">Segment: Home Route</p>
            <p>Welcome to the RSC Router demo!</p>

            <TestGetLoaderComponent />

            <h2>Features to Test:</h2>
            <ul>
              <li>✅ Route matching</li>
              <li>✅ Layouts (RootLayout)</li>
              <li>
                Navigate to <a href="/blog">Blog</a> to test params
              </li>
              <li>
                Navigate to <a href="/about">About</a>
              </li>
              <li>
                Navigate to <a href="/admin">Admin</a> to test soft/hard
                revalidation
              </li>
              <li>
                Navigate to <a href="/protected?logged_in=true">Protected</a> to
                test middleware short-circuit & URL filtering
              </li>
              <li>
                Navigate to <a href="/loaders">Loaders</a> to test useLoader &
                useFetchLoader APIs
              </li>
              <li>
                Navigate to <a href="/middleware">Middleware</a> to test global,
                pattern-based, route-level, and loader middleware
              </li>
            </ul>
          </div>
        </DebugSegmentWrapper>
      ),
      () => [
        layout(
          <>
            <ParallelOutlet name="@sidebar" />
            <Outlet />
          </>,
          () => [
            //cause error
            // layout(<RootLayout />),
            parallel({ "@sidebar": "Parallel @sidebar" }),
          ]
        ),
      ]
    ),
  ]
);
