/**
 * Mock handlers for testing lazy imports
 */

import { route, map } from '../../route-definition';

// Mock route definition
export const mockRoutes = route({
  home: '/',
  about: '/about',
});

// Mock handlers using map() helper
export default map(mockRoutes, {
  [route.layout]: () => <div>MockLayout</div>,
  home: () => <div>MockHome</div>,
  about: () => <div>MockAbout</div>,
  // TypeScript now enforces: only 'home' and 'about' are valid keys!
  // asd: () => <div>MockASD</div>,  // ❌ Would be TypeScript error now!
});
