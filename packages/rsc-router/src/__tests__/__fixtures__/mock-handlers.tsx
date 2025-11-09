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
  [route.layout]: { asd: () => <div>MockLayout</div> },
  home: () => <div>MockHome</div>,
  about: () => <div>MockAbout</div>,
  asd: () => <div>MockASD</div>,
});
