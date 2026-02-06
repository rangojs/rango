import { DebugSegmentWrapper } from "../components/DebugSegmentWrapper.js";
import { TestGetLoaderComponent } from "../components/TestGetLoader.js";

export function HomePage() {
  return (
    <DebugSegmentWrapper type="route" name="Home">
      <div>
        <h1>Test</h1>
        <p className="segment-id">Segment: Home Route</p>
        <p>Welcome to the RSC Router demo!</p>

        <TestGetLoaderComponent />

        <h2>Features to Test:</h2>
        <ul>
          <li>Route matching</li>
          <li>Layouts (RootLayout)</li>
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
            test middleware short-circuit &amp; URL filtering
          </li>
          <li>
            Navigate to <a href="/loaders">Loaders</a> to test useLoader &amp;
            useFetchLoader APIs
          </li>
          <li>
            Navigate to <a href="/middleware">Middleware</a> to test global,
            pattern-based, route-level, and loader middleware
          </li>
        </ul>
      </div>
    </DebugSegmentWrapper>
  );
}
