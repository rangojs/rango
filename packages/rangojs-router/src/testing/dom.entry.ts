/**
 * @rangojs/router/testing/dom
 *
 * Component-render testing: `renderRoute`, the React-Testing-Library-style stub
 * for client components that read router context (useParams / useReverse /
 * Outlet / useNavigation / useLoader).
 *
 * Separate from the main `@rangojs/router/testing` barrel so unit suites that
 * only test loaders, middleware, or `dispatch` never reference React, the
 * browser runtime, or `@testing-library/react` (an optional peer that
 * `renderRoute` lazy-loads at call time). Run these tests in a DOM environment
 * (`happy-dom` or `jsdom`).
 */

export { renderRoute } from "./render-route.js";
export type {
  RenderRouteSpec,
  RenderRouteOptions,
  TestRouterHandle,
  RenderRouteResult,
} from "./render-route.js";
