import { map, route } from 'rsc-router';
import type { homeRoutes } from '../routes.js';
import { RootLayout } from '../layouts/RootLayout.js';

/**
 * Home handlers
 */
export default map<typeof homeRoutes>({
  [route.layout]: <RootLayout />,
  index: () => (
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
      </ul>
    </div>
  ),
});
