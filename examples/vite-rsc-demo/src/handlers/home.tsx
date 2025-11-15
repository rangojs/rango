import { map, route, layout } from 'rsc-router';
import type { homeRoutes } from '../routes.js';
import { RootLayout } from '../layouts/RootLayout.js';
import { DebugSegmentWrapper } from '../components/DebugSegmentWrapper.js';

/**
 * Home handlers
 */
export default map<typeof homeRoutes>({
  // Global layout
  [layout('*', 'root')]: <RootLayout />,

  [route('index')]: () => (
    <DebugSegmentWrapper type="route" name="Home">
      <div>
        <h1>🏠 Home</h1>
        <p className="segment-id">Segment: Home Route</p>
        <p>Welcome to the RSC Router demo!</p>
        <h2>Features to Test:</h2>
        <ul>
          <li>✅ Route matching</li>
          <li>✅ Layouts (RootLayout)</li>
          <li>Navigate to <a href="/blog">Blog</a> to test params</li>
          <li>Navigate to <a href="/about">About</a></li>
          <li>Navigate to <a href="/admin">Admin</a> to test soft/hard revalidation</li>
          <li>Navigate to <a href="/protected?logged_in=true">Protected</a> to test middleware short-circuit & URL filtering</li>
        </ul>
      </div>
    </DebugSegmentWrapper>
  ),
});
